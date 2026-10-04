import { describe, expect, it, vi } from 'vitest';
import { loadConfigFromString } from '../shared/config.js';
import { createTorrentToolHandlers } from './server.js';

describe('torrent MCP tool handlers', () => {
  it('applies the network guard before Jackett search calls', async () => {
    const config = loadConfigFromString('network_guard:\n  enabled: true\n');
    const jackett = fakeJackett();
    const qbit = fakeQbit();
    const handlers = createTorrentToolHandlers(config, { jackett, qbit, vpnStatusProvider: async () => ({ connected: false }) });

    const result = await handlers.torrent_search({ query: 'ubuntu' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected guard failure');
    expect(result.error.code).toBe('NETWORK_GUARD_BLOCKED');
    expect(jackett.search).not.toHaveBeenCalled();
  });

  it('applies the network guard before torrent_add but not torrent_list', async () => {
    const config = loadConfigFromString('network_guard:\n  enabled: true\n');
    const qbit = fakeQbit();
    const handlers = createTorrentToolHandlers(config, {
      jackett: fakeJackett(),
      qbit,
      vpnStatusProvider: async () => ({ connected: false })
    });

    const addResult = await handlers.torrent_add({ urls: ['magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'] });
    const listResult = await handlers.torrent_list({});

    expect(addResult.ok).toBe(false);
    if (addResult.ok) throw new Error('expected guard failure');
    expect(addResult.error.code).toBe('NETWORK_GUARD_BLOCKED');
    expect(qbit.add).not.toHaveBeenCalled();
    expect(listResult.ok).toBe(true);
    expect(qbit.list).toHaveBeenCalled();
  });

  it('can guard configured qBittorrent read operations per operation', async () => {
    const config = loadConfigFromString(`
network_guard:
  enabled: true
  guarded_operations:
    - torrent_list
`);
    const qbit = fakeQbit();
    const handlers = createTorrentToolHandlers(config, {
      jackett: fakeJackett(),
      qbit,
      vpnStatusProvider: async () => ({ connected: false })
    });

    const listResult = await handlers.torrent_list({});
    const getResult = await handlers.torrent_get({ hash: '0123456789abcdef0123456789abcdef01234567' });

    expect(listResult.ok).toBe(false);
    if (listResult.ok) throw new Error('expected guard failure');
    expect(listResult.error.code).toBe('NETWORK_GUARD_BLOCKED');
    expect(qbit.list).not.toHaveBeenCalled();
    expect(getResult.ok).toBe(true);
  });

  it('validates torrent_add requires url or urls before calling qBittorrent', async () => {
    const config = loadConfigFromString('network_guard:\n  enabled: false\n');
    const qbit = fakeQbit();
    const handlers = createTorrentToolHandlers(config, { jackett: fakeJackett(), qbit, vpnStatusProvider: async () => ({ connected: true }) });

    const result = await handlers.torrent_add({});

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation failure');
    expect(result.error).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'url: Supply exactly one of url, urls, magnet_uri, or torrent_url.', next_action: expect.any(String) });
    expect(qbit.add).not.toHaveBeenCalled();
  });

  it('returns structured JSON errors instead of throwing tool errors', async () => {
    const config = loadConfigFromString('network_guard:\n  enabled: false\n');
    const qbit = fakeQbit();
    qbit.get.mockRejectedValueOnce(new Error('boom token=secret'));
    const handlers = createTorrentToolHandlers(config, { jackett: fakeJackett(), qbit, vpnStatusProvider: async () => ({ connected: true }) });

    await expect(handlers.torrent_get({ hash: '0123456789abcdef0123456789abcdef01234567' })).resolves.toEqual({
      ok: false,
      error: { code: 'TOOL_ERROR', message: 'The tool operation failed' }
    });
  });

  it('rejects local and credential-bearing torrent URLs before calling qBittorrent', async () => {
    const config = loadConfigFromString('network_guard:\n  enabled: false\n');
    const qbit = fakeQbit();
    const handlers = createTorrentToolHandlers(config, { jackett: fakeJackett(), qbit, vpnStatusProvider: async () => ({ connected: true }) });

    const local = await handlers.qbittorrent_add_torrent_url({ torrent_url: 'file:///private/file.torrent' });
    const userInfo = ['user', 'secret'].join(':');
    const credential = await handlers.qbittorrent_add_torrent_url({ torrent_url: `https://${userInfo}@example.invalid/file.torrent` });

    expect(local).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(credential).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(qbit.add).not.toHaveBeenCalled();
  });

  it('redacts credential strings and user paths in successful tool data', async () => {
    const config = loadConfigFromString('network_guard:\n  enabled: false\n');
    const qbit = fakeQbit();
    const localPath = ['C:', 'Users', 'sample-user', 'Downloads'].join('\\');
    qbit.list.mockResolvedValueOnce([{
      name: 'safe',
      note: 'token=canary',
      path: localPath,
      vendor_api_key: 'namespaced-canary',
      credential_dump: 'password canary\nmachine local login guest password canary\nhost local provider.api.key canary\n<provider.api.key>canary</provider.api.key>\nprovider.api.key%3Dcanary\n%zz%61%70%69%2D%6B%65%79%3Dcanary\n%61%70%69%2D%6B%65%79%3Dcanary%zz\n{"api\\u002dkey":"canary"}',
      database_url: 'postgres://dbuser:database-canary@127.0.0.1/app',
      source: 'file:///var/app/private/config.yaml'
    }]);
    const handlers = createTorrentToolHandlers(config, { jackett: fakeJackett(), qbit, vpnStatusProvider: async () => ({ connected: true }) });

    const result = await handlers.torrent_list({});

    expect(JSON.stringify(result)).not.toContain('canary');
    expect(JSON.stringify(result)).not.toContain('sample-user');
  });

  it('redacts relative paths in successful data and handled errors', async () => {
    const config = loadConfigFromString('network_guard:\n  enabled: false\n');
    const qbit = fakeQbit();
    qbit.list.mockResolvedValueOnce([{ path: '../private/config.yaml', note: 'see private\\folder\\file.txt' }]);
    qbit.get.mockRejectedValueOnce(new (await import('../shared/errors.js')).McpError(
      'SAFE_ERROR',
      'failed at ./private/config.yaml',
      { path: 'private\\config.yaml' }
    ));
    const handlers = createTorrentToolHandlers(config, { jackett: fakeJackett(), qbit, vpnStatusProvider: async () => ({ connected: true }) });

    const success = await handlers.torrent_list({});
    const failure = await handlers.torrent_get({ hash: '0123456789abcdef0123456789abcdef01234567' });

    expect(JSON.stringify(success)).not.toContain('private');
    expect(JSON.stringify(failure)).not.toContain('private');
  });

  it('never returns arbitrary handled error messages or details', async () => {
    const config = loadConfigFromString('network_guard:\n  enabled: false\n');
    const qbit = fakeQbit();
    qbit.get.mockRejectedValueOnce(new (await import('../shared/errors.js')).McpError(
      'HOSTILE_ERROR',
      'api-key: "first canary last"',
      { secret: 'first canary last', path: '../private/config.yaml' }
    ));
    const handlers = createTorrentToolHandlers(config, { jackett: fakeJackett(), qbit, vpnStatusProvider: async () => ({ connected: true }) });

    const result = await handlers.torrent_get({ hash: '0123456789abcdef0123456789abcdef01234567' });

    expect(result).toEqual({ ok: false, error: { code: 'HOSTILE_ERROR', message: 'The tool operation failed' } });
  });
});

function fakeJackett() {
  return { search: vi.fn(), caps: vi.fn(), listIndexers: vi.fn(), testConnection: vi.fn() };
}

function fakeQbit() {
  return {
    testConnection: vi.fn().mockResolvedValue({ reachable: true }),
    add: vi.fn().mockResolvedValue({ ok: true }),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue({ ok: true }),
    resume: vi.fn().mockResolvedValue({ ok: true }),
    delete: vi.fn().mockResolvedValue({ ok: true })
  };
}
