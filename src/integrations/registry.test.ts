import { describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfigFromString } from '../shared/config.js';
import { createTorrentServer, createTorrentToolHandlers, type TorrentDeps } from '../torrent/server.js';
import { createIntegrationRegistry } from './registry.js';
import { integrationNames, integrationSettings } from './config.js';
import { runCli } from '../cli-app.js';

const base = loadConfigFromString('network_guard:\n  enabled: false');
const setup = (integrations: unknown, fetchImpl: typeof fetch = fetch) => createIntegrationRegistry({ ...base, integrations }, vi.fn(async () => ({ connected: false })), fetchImpl);
const entry = (extra = {}) => ({ enabled: true, apiKey: 'fixture-credential', ...extra });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe('optional integration isolation', () => {
  it('defaults every adapter to disabled without constructing or probing clients', async () => {
    const fetcher = vi.fn(); const registry = setup(undefined, fetcher);
    expect(Object.keys(registry.handlers)).toEqual(['p2p_integrations', 'p2p_search']);
    expect((await registry.diagnose()).map((check) => check.state)).toEqual(integrationNames.map(() => 'disabled'));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([null, [], 'canary', { enabled: true, apiKey: 123 }, { enabled: true, apiKey: 'canary', baseUrl: 'https://user:canary@bad' }, { enabled: 'true' }, { enabled: true, apiKey: 'canary', timeoutMs: 0 }])('contains bad adapter configuration %#', async (bad) => {
    const config = loadConfigFromString(`integrations:\n  slskd: ${JSON.stringify(bad)}\n  prowlarr: {enabled: true, apiKey: fixture}`);
    const fetcher = vi.fn(async () => json({ version: '1.0.0' }));
    const registry = createIntegrationRegistry(config, async () => ({ connected: true }), fetcher);
    expect(registry.handlers.slskd_search).toBeUndefined();
    expect(await registry.handlers.prowlarr_test({})).toMatchObject({ ok: true });
    expect((await registry.diagnose()).find((check) => check.name === 'slskd')?.state).toBe('misconfigured');
    expect(JSON.stringify(await registry.handlers.p2p_integrations({}))).not.toContain('canary');
  });

  it('ignores unusable settings when explicitly disabled and contains malformed root config', async () => {
    expect(integrationSettings({ slskd: { enabled: false, apiKey: 123 } })[0].state).toBe('disabled');
    expect(() => loadConfigFromString('integrations: canary')).not.toThrow();
    expect((await setup('canary').diagnose()).every((check) => check.state === 'misconfigured')).toBe(true);
    expect(JSON.stringify(await setup({ 'canary-key': 'canary' }).diagnose())).not.toContain('canary');
  });

  it('limits each service independently, including transports that ignore abort', async () => {
    let resolveSlow: ((value: Response) => void) | undefined;
    const fetcher = vi.fn((url: string | URL | Request) => String(url).includes(':9696')
      ? new Promise<Response>((resolve) => { resolveSlow = resolve; }) : Promise.resolve(json({ status: 'running' })));
    const registry = setup({ prowlarr: entry({ concurrency: 1, timeoutMs: 20 }), gluetun: entry() }, fetcher);
    const slow = registry.handlers.prowlarr_test({});
    expect(await registry.handlers.prowlarr_test({})).toMatchObject({ ok: false, error: { code: 'INTEGRATION_BUSY' } });
    expect(await registry.handlers.gluetun_test({})).toMatchObject({ ok: true });
    expect(await slow).toMatchObject({ ok: false, error: { code: 'INTEGRATION_TIMEOUT' } });
    expect(await registry.handlers.prowlarr_test({})).toMatchObject({ ok: false, error: { code: 'INTEGRATION_BUSY' } });
    resolveSlow!(json({ version: '1' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await registry.handlers.gluetun_test({})).toMatchObject({ ok: true });
  });

  it('preserves successful search results when another provider fails', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).includes(':9696') ? json([{ title: 'Fixture', downloadUrl: 'https://private/?token=canary' }]) : json({ message: 'canary' }, 503));
    const registry = setup({ prowlarr: entry(), slskd: entry() }, fetcher);
    const result = await registry.handlers.p2p_search({ query: 'fixture' });
    expect(result).toMatchObject({ ok: true, data: { status: 'partial', providers: [
      { provider: 'slskd', status: 'failed', ok: false }, { provider: 'prowlarr', status: 'completed', data: { results: [{ title: 'Fixture' }] } }
    ] } });
    expect(JSON.stringify(result)).not.toMatch(/canary|downloadUrl/);
  });

  it('includes the existing Jackett search without losing a successful optional provider', async () => {
    const registry = setup({ prowlarr: entry() }, vi.fn(async () => json([{ title: 'Fixture' }])));
    const jackett = vi.fn(async () => ({ ok: false as const, error: { code: 'JACKETT_UNREACHABLE', message: 'Unavailable' } }));
    registry.setJackettSearch(jackett);
    const result = await registry.handlers.p2p_search({ query: 'fixture' });
    expect(result).toMatchObject({ ok: true, data: { status: 'partial', providers: [{ provider: 'jackett', status: 'failed' }, { provider: 'prowlarr', status: 'completed' }] } });
    expect(jackett).toHaveBeenCalledWith({ query: 'fixture', limit: 25 });
  });

  it('validates mutations and checks the guard before any HTTP requests', async () => {
    const fetcher = vi.fn(); const config = { ...loadConfigFromString(''), integrations: { transmission: { enabled: true } } };
    const registry = createIntegrationRegistry(config, async () => ({ connected: false }), fetcher);
    expect(await registry.handlers.transmission_delete({ hashes: [] })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(await registry.handlers.transmission_add({ source: 'https://fixture.invalid/a.torrent' })).toMatchObject({ ok: false, error: { code: 'NETWORK_GUARD_BLOCKED' } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps malformed optional settings from breaking legacy handlers or MCP startup', async () => {
    const config = { ...base, integrations: { slskd: { enabled: true }, ipfs: { enabled: false } } };
    const deps = { jackett: {}, qbit: {}, vpnStatusProvider: vi.fn() } as unknown as TorrentDeps;
    expect(await createTorrentToolHandlers(config, deps).jackett_get_category({ query: 'audio' })).toMatchObject({ ok: true });
    const server = createTorrentServer(config, deps); const client = new Client({ name: 'isolation', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(b); await client.connect(a);
      const tools = (await client.listTools()).tools;
      expect(tools.some((tool) => tool.name.startsWith('slskd_') || tool.name.startsWith('ipfs_'))).toBe(false);
      expect((await client.callTool({ name: 'jackett_get_category', arguments: { query: 'audio' } })).isError).not.toBe(true);
    } finally { await client.close(); await server.close(); }
  });

  it('reports failed optional probes as degraded diagnostics without marking healthy core checks blocked', async () => {
    const config = { ...loadConfigFromString(''), integrations: { slskd: { enabled: true }, prowlarr: entry() } };
    const deps = {
      jackett: { testConnection: vi.fn(async () => ({ admin_api_ok: true, indexers_configured: 1 })) },
      qbit: { testConnection: vi.fn(async () => ({ version: '5.0.0' })) }, vpnStatusProvider: vi.fn(async () => ({ connected: true }))
    } as unknown as TorrentDeps;
    const registry = createIntegrationRegistry(config, deps.vpnStatusProvider, vi.fn(async () => json({}, 503)));
    const result = await createTorrentToolHandlers(config, deps, registry).p2p_doctor({});
    expect(result).toMatchObject({ ok: true, data: { status: 'attention_needed', integrations: expect.arrayContaining([
      expect.objectContaining({ name: 'slskd', state: 'misconfigured' }), expect.objectContaining({ name: 'prowlarr', state: 'unreachable' })
    ]) } });
  });

  it('provides config-free adapter help and confirms destructive commands before config loading', async () => {
    const loadConfig = vi.fn(() => { throw Error('must not run'); }); let text = '';
    const runtime = { loadConfig, stdout: (value: string) => { text += value; }, stderr: vi.fn() };
    expect(await runCli(['slskd', 'download', '--help'], runtime)).toBe(0);
    expect(text).toContain('file_ids');
    expect(text).toContain('Required fields: search_id, username, file_ids');
    expect(await runCli(['transmission', 'delete', '--hashes', 'a'.repeat(40)], runtime)).toBe(2);
    expect(await runCli(['ipfs', 'pin-remove', '--cid', 'Qm' + 'a'.repeat(44)], runtime)).toBe(2);
    expect(loadConfig).not.toHaveBeenCalled();
  });
});

describe('actual HTTP failure boundaries', () => {
  async function listen(server: Server) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  async function close(server: Server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }

  it('times out stalled bodies and rejects oversized responses and credential redirects without retries', async () => {
    let calls = 0; let mode = 'stall';
    const server = createServer((_req, res) => {
      calls++;
      if (mode === 'stall') { res.writeHead(200); res.write('{'); }
      else if (mode === 'large') res.end(JSON.stringify({ data: 'x'.repeat(2048) }));
      else { res.writeHead(307, { Location: '/leak' }); res.end(); }
    });
    const baseUrl = await listen(server);
    try {
      // Leave enough time for valid local responses when Android builds load the host.
      // The stalled response still exercises the same real cancellation boundary.
      const registry = setup({ prowlarr: entry({ baseUrl, timeoutMs: 1000, maxResponseBytes: 1024 }) });
      expect(await registry.handlers.prowlarr_test({})).toMatchObject({ ok: false, error: { code: 'INTEGRATION_TIMEOUT' } });
      mode = 'large';
      expect(await registry.handlers.prowlarr_test({})).toMatchObject({ ok: false, error: { code: 'INTEGRATION_RESPONSE_TOO_LARGE' } });
      mode = 'redirect';
      expect(await registry.handlers.prowlarr_test({})).toMatchObject({ ok: false, error: { code: 'INTEGRATION_REQUEST_FAILED' } });
      expect(calls).toBe(3);
    } finally { await close(server); }
  });
});
