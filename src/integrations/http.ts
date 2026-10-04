import { McpError } from '../shared/errors.js';
import type { IntegrationConfig } from './config.js';

export class IntegrationHttp {
  constructor(private readonly config: IntegrationConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  async request(path: string, signal: AbortSignal, options: {
    method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown; query?: URLSearchParams;
    text?: boolean; allow409?: boolean; allow404?: boolean;
  } = {}): Promise<{ data: unknown; status: number; sessionId: string | null }> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}${path}${options.query?.size ? `?${options.query}` : ''}`;
    const response = await this.fetchImpl(url, { method: options.method ?? 'GET', headers, signal, redirect: 'error', ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
    if (response.status === 409 && options.allow409) {
      await response.body?.cancel();
      return { data: null, status: 409, sessionId: response.headers.get('X-Transmission-Session-Id') };
    }
    if (response.status === 404 && options.allow404) {
      await response.body?.cancel();
      return { data: null, status: 404, sessionId: null };
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new McpError([401, 403].includes(response.status) ? 'INTEGRATION_AUTH_FAILED' : 'INTEGRATION_REQUEST_FAILED', 'Integration request failed');
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > this.config.maxResponseBytes) throw new McpError('INTEGRATION_RESPONSE_TOO_LARGE', 'Integration response exceeded its configured limit');
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (options.text) return { data: text, status: response.status, sessionId: null };
    try { return { data: text ? JSON.parse(text) : null, status: response.status, sessionId: null }; }
    catch { throw new McpError('INTEGRATION_INVALID_RESPONSE', 'Integration returned invalid JSON'); }
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new McpError('INTEGRATION_INVALID_RESPONSE', 'Expected response object');
  return value as Record<string, unknown>;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new McpError('INTEGRATION_INVALID_RESPONSE', 'Expected response array');
  return value;
}
/** Allowlist output properties before the shared redactor; never forward whole upstream objects. */
export function pick(value: unknown, keys: string[]): Record<string, unknown> {
  const input = record(value);
  return Object.fromEntries(keys.filter((key) => ['string', 'number', 'boolean'].includes(typeof input[key]) || input[key] === null).map((key) => [key, input[key]]));
}
