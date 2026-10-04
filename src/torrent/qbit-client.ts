import { McpError } from '../shared/errors.js';
import { normalizeTorrent, normalizeTorrentDetails } from './qbit-normalize.js';
import type { QbitAddOptions, QbitClientOptions, QbitListOptions, QbitTorrentInfo, QbitTorrentProperties } from './qbit-types.js';

export class QbitClient {
  private sid?: string;
  private majorVersion?: number;
  private readonly baseUrl: string;

  constructor(private readonly options: QbitClientOptions, private readonly fetchImpl: typeof fetch = fetch) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  async testConnection(): Promise<{ reachable: true; authenticated: true; version: string | null }> {
    const version = (await this.request('app/version')).trim();
    return { reachable: true, authenticated: true, version: version || null };
  }

  async list(options: QbitListOptions | string = {}): Promise<ReturnType<typeof normalizeTorrent>[]> {
    const normalizedOptions = typeof options === 'string' ? { filter: options } : options;
    const params = new URLSearchParams();
    if (normalizedOptions.filter) params.set('filter', normalizedOptions.filter === 'paused' && await this.getMajorVersion() >= 5 ? 'stopped' : normalizedOptions.filter);
    if (normalizedOptions.category !== undefined) params.set('category', normalizedOptions.category);
    if (normalizedOptions.tag !== undefined) params.set('tag', normalizedOptions.tag);
    if (normalizedOptions.sort) params.set('sort', normalizedOptions.sort);
    if (normalizedOptions.limit) params.set('limit', String(normalizedOptions.limit));
    if (normalizedOptions.hashes?.length) params.set('hashes', normalizedOptions.hashes.join('|'));
    const text = await this.request('torrents/info', params.size ? { query: params } : undefined);
    return (JSON.parse(text) as QbitTorrentInfo[]).map(normalizeTorrent);
  }

  async get(hash: string): Promise<ReturnType<typeof normalizeTorrentDetails>> {
    const params = new URLSearchParams({ hashes: hash });
    const torrents = JSON.parse(await this.request('torrents/info', { query: params })) as QbitTorrentInfo[];
    const torrent = torrents.find((item) => item.hash.toLowerCase() === hash.toLowerCase());
    if (!torrent) throw new McpError('TORRENT_NOT_FOUND', `Torrent not found for hash: ${hash}`);
    const properties = JSON.parse(await this.request('torrents/properties', { query: new URLSearchParams({ hash }) })) as QbitTorrentProperties;
    return normalizeTorrentDetails(torrent, properties);
  }

  async add(options: QbitAddOptions): Promise<{ ok: true }> {
    const body = new FormData();
    if (options.urls?.length) body.set('urls', options.urls.join('\n'));
    if (options.savepath) body.set('savepath', options.savepath);
    if (options.category) body.set('category', options.category);
    if (options.tags?.length) body.set('tags', options.tags.join(','));
    body.set('paused', String(options.paused ?? false));
    // 4.x reads paused; 5.x reads stopped. Both ignore the other field.
    body.set('stopped', String(options.paused ?? false));
    body.set('skip_checking', String(options.skipChecking ?? false));
    const result = (await this.request('torrents/add', { method: 'POST', body })).trim();
    if (result !== 'Ok.') throw new McpError('QBIT_REQUEST_FAILED', 'qBittorrent did not accept the torrent addition');
    return { ok: true };
  }

  async pause(hashes: string[]): Promise<{ ok: true }> {
    await this.compatibleHashAction('torrents/stop', 'torrents/pause', hashes);
    return { ok: true };
  }

  async resume(hashes: string[]): Promise<{ ok: true }> {
    await this.compatibleHashAction('torrents/start', 'torrents/resume', hashes);
    return { ok: true };
  }

  async delete(hashes: string[], deleteFiles = false): Promise<{ ok: true }> {
    await this.request('torrents/delete', { method: 'POST', body: new URLSearchParams({ hashes: hashes.join('|'), deleteFiles: String(deleteFiles) }) });
    return { ok: true };
  }

  private async compatibleHashAction(primary: string, fallback: string, hashes: string[]): Promise<void> {
    const init = { method: 'POST', body: new URLSearchParams({ hashes: hashes.join('|') }) };
    try {
      await this.request(primary, init);
    } catch (error) {
      if (!(error instanceof McpError) || (error.details as { status?: number } | undefined)?.status !== 404) throw error;
      await this.request(fallback, init);
    }
  }

  private async login(): Promise<void> {
    const body = new URLSearchParams();
    if (this.options.username) body.set('username', this.options.username);
    if (this.options.password) body.set('password', this.options.password);
    const { response, text } = await this.rawFetch('auth/login', { method: 'POST', body }, false);
    if (!response.ok || !/^Ok\.?$/i.test(text.trim())) {
      throw new McpError('QBIT_LOGIN_FAILED', 'qBittorrent rejected the configured credentials');
    }
    this.sid = parseSid(response.headers.get('set-cookie'));
  }

  private async request(endpoint: string, init?: RequestOptions): Promise<string> {
    if (!this.sid) await this.login();
    let result = await this.rawFetch(endpoint, init, true);
    if (result.response.status === 403) {
      this.sid = undefined;
      await this.login();
      result = await this.rawFetch(endpoint, init, true);
    }
    const { response, text } = result;
    if (response.status === 401 || response.status === 403) throw new McpError('QBIT_LOGIN_FAILED', 'qBittorrent rejected the configured credentials');
    if (!response.ok) {
      throw new McpError('QBIT_REQUEST_FAILED', 'qBittorrent request failed', { endpoint, status: response.status });
    }
    return text;
  }

  private async getMajorVersion(): Promise<number> {
    if (this.majorVersion === undefined) {
      const version = (await this.request('app/version')).trim();
      const match = /^v?(\d+)\./.exec(version);
      if (!match || Number(match[1]) < 4) throw new McpError('QBIT_REQUEST_FAILED', 'qBittorrent version could not be determined');
      this.majorVersion = Number(match[1]);
    }
    return this.majorVersion;
  }

  private async rawFetch(endpoint: string, init: RequestOptions = {}, authenticated = true): Promise<{ response: Response; text: string }> {
    const controller = new AbortController();
    const timeout = this.options.timeoutMs ? setTimeout(() => controller.abort(), this.options.timeoutMs) : undefined;
    try {
      const url = new URL(`${this.baseUrl}/api/v2/${endpoint}`);
      if (init.query) url.search = init.query.toString();
      const origin = new URL(this.baseUrl).origin;
      const response = await this.fetchImpl(url.toString(), {
        method: init.method ?? 'GET',
        body: init.body,
        headers: {
          Origin: origin,
          Referer: `${origin}/`,
          ...(authenticated && this.sid ? { Cookie: `SID=${this.sid}` } : {})
        },
        signal: controller.signal,
        redirect: 'error'
      });
      const text = await response.text();
      return { response, text };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new McpError('QBIT_UNREACHABLE', 'qBittorrent request timed out');
      throw new McpError('QBIT_UNREACHABLE', 'Could not reach the configured qBittorrent service');
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

interface RequestOptions { method?: string; body?: BodyInit; query?: URLSearchParams }

function parseSid(setCookie: string | null): string | undefined {
  return setCookie?.match(/(?:^|;)\s*SID=([^;]+)/i)?.[1] ?? setCookie?.match(/^SID=([^;]+)/i)?.[1];
}
