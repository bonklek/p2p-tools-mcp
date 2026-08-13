import { McpError } from '../shared/errors.js';
import { normalizeJackettCaps, normalizeJackettSearch, type JackettCaps, type JackettSearchResult } from './jackett-normalize.js';

export interface JackettClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface JackettSearchOptions {
  query?: string;
  indexer?: string;
  searchType?: 'search' | 'tvsearch' | 'movie' | 'music' | 'book';
  categories?: number[];
  season?: number;
  episode?: string;
  imdbId?: string;
  limit?: number;
  offset?: number;
}

export interface JackettIndexer {
  id: string;
  name?: string;
  configured?: boolean;
  type?: string;
}

export class JackettClient {
  private readonly baseUrl: string;

  constructor(private readonly options: JackettClientOptions, private readonly fetchImpl: typeof fetch = fetch) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  async search(options: JackettSearchOptions): Promise<{ results: JackettSearchResult[]; total: number; offset: number; limit: number }> {
    const indexer = options.indexer ?? 'all';
    const searchType = options.searchType ?? 'search';
    const limit = options.limit ?? 25;
    const offset = options.offset ?? 0;
    const params = new URLSearchParams({ t: searchType, limit: String(limit), offset: String(offset) });
    if (options.query) params.set('q', options.query);
    if (this.options.apiKey) params.set('apikey', this.options.apiKey);
    if (options.categories?.length) params.set('cat', options.categories.join(','));
    if (searchType === 'tvsearch' && options.season !== undefined) params.set('season', String(options.season));
    if (searchType === 'tvsearch' && options.episode) params.set('ep', options.episode);
    if (searchType === 'movie' && options.imdbId) params.set('imdbid', options.imdbId);
    const xml = await this.request(`/api/v2.0/indexers/${encodeURIComponent(indexer)}/results/torznab/api`, params);
    const results = normalizeJackettSearch(xml, indexer);
    return { results, total: results.length, offset, limit };
  }

  async caps(indexer = 'all'): Promise<JackettCaps> {
    const params = new URLSearchParams({ t: 'caps' });
    if (this.options.apiKey) params.set('apikey', this.options.apiKey);
    const xml = await this.request(`/api/v2.0/indexers/${encodeURIComponent(indexer)}/results/torznab/api`, params);
    return normalizeJackettCaps(xml, indexer);
  }

  async listIndexers(): Promise<JackettIndexer[]> {
    const params = new URLSearchParams({ configured: 'true' });
    if (this.options.apiKey) params.set('apikey', this.options.apiKey);
    const text = await this.request('/api/v2.0/indexers', params);
    try {
      const payload = JSON.parse(text) as unknown;
      const indexers = Array.isArray(payload) ? payload : (payload as { indexers?: unknown[] })?.indexers;
      if (!Array.isArray(indexers)) throw new Error('unrecognized response shape');
      return indexers.flatMap((value): JackettIndexer[] => {
        if (!value || typeof value !== 'object') return [];
        const item = value as Record<string, unknown>;
        if (typeof item.id !== 'string') return [];
        return [{
          id: item.id,
          ...(typeof item.name === 'string' ? { name: item.name } : {}),
          ...(typeof item.configured === 'boolean' ? { configured: item.configured } : {}),
          ...(typeof item.type === 'string' ? { type: item.type } : {})
        }];
      });
    } catch {
      throw new McpError('JACKETT_ADMIN_API_UNAVAILABLE', 'Jackett admin API returned an invalid response');
    }
  }

  async testConnection(): Promise<{ connected: true; api_key_valid: true; response_time_ms: number; torznab_ok: true; admin_api_ok: boolean; indexers_configured: number | null; warnings: string[] }> {
    const started = Date.now();
    await this.caps('all');
    const warnings: string[] = [];
    let indexersConfigured: number | null = null;
    let adminApiOk = false;
    try {
      const indexers = await this.listIndexers();
      adminApiOk = true;
      indexersConfigured = indexers.filter((indexer) => indexer.configured !== false).length;
    } catch {
      warnings.push('Jackett admin API unavailable');
    }
    return {
      connected: true,
      api_key_valid: true,
      response_time_ms: Date.now() - started,
      torznab_ok: true,
      admin_api_ok: adminApiOk,
      indexers_configured: indexersConfigured,
      warnings
    };
  }

  private async request(path: string, params: URLSearchParams): Promise<string> {
    const controller = new AbortController();
    const timeout = this.options.timeoutMs ? setTimeout(() => controller.abort(), this.options.timeoutMs) : undefined;
    try {
      const url = new URL(`${this.baseUrl}${path}`);
      url.search = params.toString();
      const response = await this.fetchImpl(url.toString(), { signal: controller.signal });
      const text = await response.text();
      if (response.status === 401 || response.status === 403) {
        throw new McpError('JACKETT_AUTH_FAILED', 'Jackett rejected the configured API key', { status: response.status });
      }
      if (!response.ok) {
        throw new McpError('JACKETT_REQUEST_FAILED', 'Jackett request failed', { status: response.status });
      }
      return text;
    } catch (error) {
      if (error instanceof McpError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new McpError('JACKETT_UNREACHABLE', 'Jackett request timed out', { timeoutMs: this.options.timeoutMs });
      }
      // Do not include the request URL here: it contains the Jackett API key.
      throw new McpError('JACKETT_UNREACHABLE', 'Could not reach the configured Jackett service');
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
