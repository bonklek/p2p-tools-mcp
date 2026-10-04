import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../shared/config.js';
import { checkNetworkGuard, type VpnStatusProvider } from '../shared/network-guard.js';
import { McpError } from '../shared/errors.js';
import { publicDiagnostic, schemaGuidance, validationError } from '../shared/diagnostics.js';
import { structuredResult, type ToolResult } from '../shared/tool-result.js';
import { integrationSettings, unknownIntegrations, type IntegrationName } from './config.js';
import { IntegrationHttp } from './http.js';
import { inspectionOperations } from './inspection.js';
import { prowlarrOperations } from './prowlarr.js';
import { slskdOperations } from './slskd.js';
import { crossSeedOperations } from './cross-seed.js';
import { transmissionOperations } from './transmission.js';
import type { IntegrationOperation } from './types.js';

export const integrationOperations = [...inspectionOperations, ...prowlarrOperations, ...slskdOperations, ...crossSeedOperations, ...transmissionOperations];
type Handler = (args: unknown) => Promise<ToolResult>;
export interface IntegrationCheck {
  name: IntegrationName | 'integrations'; state: 'disabled' | 'misconfigured' | 'healthy' | 'unreachable' | 'busy';
  message: string; next_action?: string;
}
const messages: Record<string, string> = {
  INTEGRATION_BUSY: 'This integration has reached its concurrency limit.',
  INTEGRATION_TIMEOUT: 'The integration deadline expired; a mutation may still have taken effect.',
  INTEGRATION_AUTH_FAILED: 'The integration rejected its configured credentials.',
  INTEGRATION_REQUEST_FAILED: 'The integration request failed; inspect service state before retrying a mutation.',
  INTEGRATION_INVALID_RESPONSE: 'The service returned an unexpected response; inspect state before retrying a mutation.',
  INTEGRATION_RESPONSE_TOO_LARGE: 'The service response exceeded its configured byte limit.',
  INTEGRATION_UNSUPPORTED_VERSION: 'The service version is outside this adapter\'s supported range.',
  INTEGRATION_SELECTION_EXPIRED: 'Selected files are no longer available; read search results again.',
  INTEGRATION_NOT_FOUND: 'The requested search is no longer available.',
  NETWORK_GUARD_BLOCKED: 'Network guard blocked this operation.'
};
const safeMessage = (code: string) => messages[code] ?? 'The integration operation failed.';

export function createIntegrationRegistry(config: AppConfig, vpnStatusProvider: VpnStatusProvider, fetchImpl: typeof fetch = fetch) {
  const settings = integrationSettings(config.integrations);
  const active = new Map<IntegrationName, number>();
  const clients = new Map<IntegrationName, IntegrationHttp>();
  let jackettSearch: Handler | undefined;
  const handlers: Record<string, Handler> = {};
  const specs: Record<string, { description: string; inputSchema: z.ZodRawShape; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }> = {};
  const execute = async (operation: IntegrationOperation, input: Record<string, unknown>) => {
    const setting = settings.find((setting) => setting.name === operation.service)!;
    if (setting.state !== 'configured') throw new McpError('INTEGRATION_UNAVAILABLE', 'Integration unavailable');
    const count = active.get(operation.service) ?? 0;
    if (count >= setting.config.concurrency) throw new McpError('INTEGRATION_BUSY', 'Integration busy');
    active.set(operation.service, count + 1);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new McpError('INTEGRATION_TIMEOUT', 'Deadline expired')); }, setting.config.timeoutMs);
    });
    const work = (async () => {
      if (operation.guard) {
        const guard = await checkNetworkGuard(config, vpnStatusProvider, operation.guard);
        if (!guard.allowed) throw new McpError('NETWORK_GUARD_BLOCKED', 'Guard blocked');
      }
      // Do not start a service request after a slow guard has already exhausted the deadline.
      controller.signal.throwIfAborted();
      let http = clients.get(operation.service);
      if (!http) { http = new IntegrationHttp(setting.config, fetchImpl); clients.set(operation.service, http); }
      return operation.run({ config: setting.config, http, signal: controller.signal }, input);
    })().catch((error: unknown) => {
      if (error instanceof McpError) throw error;
      throw new McpError(controller.signal.aborted ? 'INTEGRATION_TIMEOUT' : 'INTEGRATION_REQUEST_FAILED', 'Integration operation failed');
    });
    // Retain the slot until the work really stops, even if a custom transport ignores cancellation.
    void work.finally(() => active.set(operation.service, (active.get(operation.service) ?? 1) - 1)).catch(() => {});
    try { return await Promise.race([work, deadline]); }
    finally { clearTimeout(timer); }
  };

  for (const operation of integrationOperations) {
    if (settings.find((setting) => setting.name === operation.service)?.state !== 'configured') continue;
    const name = `${operation.service}_${operation.action}`;
    specs[name] = { description: operation.description, inputSchema: operation.schema, annotations: { readOnlyHint: !operation.mutation, destructiveHint: !!operation.destructive } };
    handlers[name] = async (args) => {
      const parsed = z.strictObject(operation.schema).safeParse(args ?? {});
      if (!parsed.success) return { ok: false, error: publicDiagnostic(validationError(parsed.error, schemaGuidance(operation.schema)), 'Invalid tool argument') };
      const input: Record<string, unknown> = parsed.data;
      const idKey = operation.service === 'slskd' ? operation.action === 'search' ? 'search_id' : operation.action === 'download' ? 'batch_id' : undefined : undefined;
      if (idKey) input[idKey] = String(input[idKey] ?? randomUUID()).toLowerCase();
      const result = await structuredResult(() => execute(operation, input), safeMessage);
      return !result.ok && idKey ? { ...result, error: { ...result.error, request_id: String(input[idKey]) } } : result;
    };
  }

  async function diagnose(): Promise<IntegrationCheck[]> {
    const checks = await Promise.all(settings.map(async (setting): Promise<IntegrationCheck> => {
      if (setting.state === 'disabled') return { name: setting.name, state: 'disabled', message: 'Disabled; no service client or probe was created.' };
      if (setting.state === 'misconfigured') return { name: setting.name, state: 'misconfigured', message: 'This optional integration has invalid configuration.', next_action: 'Review this integration section in the basket guide; other integrations remain available.' };
      const result = await handlers[`${setting.name}_test`]({});
      return result.ok
        ? { name: setting.name, state: 'healthy', message: setting.name === 'cross_seed' ? 'Ping succeeded; credentials and configured dependencies remain unverified.' : 'API probe succeeded; this does not verify peer connectivity, workflow completion, or traffic isolation.' }
        : { name: setting.name, state: result.error.code === 'INTEGRATION_BUSY' ? 'busy' : 'unreachable', message: result.error.message, next_action: result.error.next_action ?? 'Review this service health and configuration, then rerun doctor.' };
    }));
    if (unknownIntegrations(config.integrations)) checks.push({ name: 'integrations', state: 'misconfigured', message: 'Unknown integration names were ignored.', next_action: 'Use only the integration names documented in the basket guide.' });
    return checks;
  }

  {
    specs.p2p_integrations = { description: 'List optional integration configuration states without probing services.', inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false } };
    handlers.p2p_integrations = async (args) => {
      const parsed = z.strictObject({}).safeParse(args ?? {});
      if (!parsed.success) return { ok: false, error: publicDiagnostic(validationError(parsed.error, {}), 'Invalid argument') };
      return { ok: true, data: { integrations: settings.map(({ name, state }) => ({ name, state })), unknown_names_ignored: unknownIntegrations(config.integrations) } };
    };
    const searchShape = { query: z.string().min(1).max(512), providers: z.array(z.enum(['jackett', 'prowlarr', 'slskd'])).min(1).max(3).optional(), limit: z.number().int().min(1).max(100).default(25) };
    specs.p2p_search = { description: 'Search configured basket providers independently; slskd returns a pending search ID. Failed providers do not discard other results.', inputSchema: searchShape, annotations: { readOnlyHint: false, destructiveHint: false } };
    handlers.p2p_search = async (args) => {
      const parsed = z.strictObject(searchShape).safeParse(args ?? {});
      if (!parsed.success) return { ok: false, error: publicDiagnostic(validationError(parsed.error, schemaGuidance(searchShape)), 'Invalid argument') };
      const names = [...new Set(parsed.data.providers ?? [ ...(jackettSearch ? ['jackett'] : []), ...settings.filter((setting) => setting.state === 'configured' && ['prowlarr', 'slskd'].includes(setting.name)).map((setting) => setting.name)])];
      const providers = await Promise.all(names.map(async (provider) => {
        const handler = provider === 'jackett' ? jackettSearch : handlers[`${provider}_search`];
        const result = handler ? await handler({ query: parsed.data.query, limit: parsed.data.limit }) : { ok: false as const, error: { code: 'INTEGRATION_UNAVAILABLE', message: 'Provider is disabled or misconfigured.' } };
        return { provider, status: result.ok ? provider === 'slskd' ? 'pending' : 'completed' : 'failed', ...result };
      }));
      const successes = providers.filter((provider) => provider.ok).length;
      return { ok: true, data: { status: !successes ? 'failed' : successes < providers.length ? 'partial' : providers.some((provider) => provider.status === 'pending') ? 'pending' : 'complete', providers } };
    };
  }
  return { handlers, specs, diagnose, setJackettSearch: (handler: Handler) => { jackettSearch = handler; } };
}
