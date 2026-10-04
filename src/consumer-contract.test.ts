import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTorrentServer, createTorrentToolHandlers, type TorrentDeps } from './torrent/server.js';
import { createVpnServer, createVpnToolHandlers } from './vpn/server.js';
import { loadConfigFromString } from './shared/config.js';
import { McpError } from './shared/errors.js';
import { NordVpnClient } from './vpn/nordvpn.js';
import { runCli } from './cli-app.js';

const hash = '0123456789abcdef0123456789abcdef01234567';
const config = loadConfigFromString('network_guard:\n  enabled: false');
function deps(): TorrentDeps {
  return {
    jackett: { search: vi.fn(), caps: vi.fn(), listIndexers: vi.fn(), testConnection: vi.fn() },
    qbit: { add: vi.fn().mockResolvedValue({ ok: true }), delete: vi.fn().mockResolvedValue({ ok: true }), pause: vi.fn(), resume: vi.fn(), get: vi.fn(), list: vi.fn().mockResolvedValue([]), testConnection: vi.fn() },
    vpnStatusProvider: vi.fn().mockResolvedValue({ connected: true })
  };
}

describe('consumer input boundaries', () => {
  it.each(['qbittorrent_delete_torrent', 'torrent_delete', 'qbittorrent_pause_torrent', 'qbittorrent_resume_torrent'])('limits %s to explicit hash targets', async (name) => {
    const services = deps(); const handlers = createTorrentToolHandlers(config, services);
    for (const args of [{ hash: 'all', delete_files: true }, { hash: `${hash}|${hash}` }, { hashes: ['all'] }, { hash: '' }, { hashes: [] }, { hash, hashes: [hash] }]) {
      expect(await handlers[name](args)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    }
    expect(services.qbit.delete).not.toHaveBeenCalled(); expect(services.qbit.pause).not.toHaveBeenCalled(); expect(services.qbit.resume).not.toHaveBeenCalled();
  });

  it('retains valid batch deletion and explicit file-retention default', async () => {
    const services = deps(); const handlers = createTorrentToolHandlers(config, services);
    expect(await handlers.qbittorrent_delete_torrent({ hashes: [hash.toUpperCase(), hash] })).toMatchObject({ ok: true });
    expect(services.qbit.delete).toHaveBeenCalledWith([hash], false);
    await handlers.torrent_delete({ hash: 'a'.repeat(64), deleteFiles: true });
    expect(services.qbit.delete).toHaveBeenLastCalledWith(['a'.repeat(64)], true);
  });

  it('rejects unknown fields and unsafe/ambiguous compatibility add inputs', async () => {
    const services = deps(); const handlers = createTorrentToolHandlers(config, services);
    for (const args of [{ url: 'file:///fixture' }, { urls: ['https://user:canary@fixture.invalid/a'] }, { magnet_uri: 'magnet:?xt=urn:btih:abc' }, { url: `https://fixture.invalid/a\nhttps://fixture.invalid/b` }, { url: 'https://fixture.invalid/a', urls: ['https://fixture.invalid/b'] }]) {
      expect(await handlers.torrent_add(args)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    }
    expect(await handlers.qbittorrent_delete_torrent({ hash, deleteFiles: true })).toMatchObject({ ok: false });
    expect(await handlers.torrent_delete({ hash, deleteFiles: false, delete_files: true })).toMatchObject({ ok: false });
    expect(await handlers.torrent_add({ url: 'https://fixture.invalid/a', skipChecking: true, skip_checking: false })).toMatchObject({ ok: false });
    expect(await handlers.qbittorrent_add_magnet({ magnet_uri: `magnet:?xt=urn:btih:${hash}`, puased: true })).toMatchObject({ ok: false });
    expect(services.qbit.add).not.toHaveBeenCalled(); expect(services.qbit.delete).not.toHaveBeenCalled();
  });

  it('uses exit 2 for real handler validation and shows command help without configuration', async () => {
    let output = '';
    const runtime = { loadConfig: () => config, stdout: (s: string) => { output += s; }, stderr: () => {}, torrentHandlers: () => createTorrentToolHandlers(config, deps()) };
    expect(await runCli(['jackett', 'search', '--limit', '0'], runtime)).toBe(2);
    expect(await runCli(['qbit', 'list', '--filter', 'nonsense'], runtime)).toBe(2);
    expect(output).toContain('INVALID_ARGUMENT');
    output = '';
    expect(await runCli(['qbit', 'add-magnet', '--help'], { ...runtime, loadConfig: () => { throw Error('must not load'); } })).toBe(0);
    expect(output).toContain('magnet_uri'); expect(output).toContain('--stdin');
  });
});

describe('MCP SDK contract', () => {
  it.each(['', 'Status: Disconnecting', 'Unexpected output'])('does not verify disconnect from unknown status %j', async (statusOutput) => {
    const runner = vi.fn(async (_command: string, args: string[]) => ({ stdout: args[0] === 'status' ? statusOutput : '', stderr: '', exitCode: 0 }));
    const client = new NordVpnClient({ command: 'fixture', platform: 'linux' }, runner);
    const handlers = createVpnToolHandlers(config, client);
    expect(await handlers.vpn_disconnect({})).toEqual({ ok: true, data: { connected: null, command_accepted: true, state_verified: false } });
  });
  it('advertises tools, preserves result envelopes, and blocks invalid mutations', async () => {
    const services = deps(); const server = createTorrentServer(config, services);
    const client = new Client({ name: 'fixture', version: '1' });
    const [left, right] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(right); await client.connect(left);
      const listed = await client.listTools();
      const remove = listed.tools.find((tool) => tool.name === 'qbittorrent_delete_torrent');
      expect(remove?.annotations?.destructiveHint).toBe(true);
      expect(remove?.inputSchema.additionalProperties).toBe(false);
      const result = await client.callTool({ name: 'jackett_get_category', arguments: { query: 'audio' } });
      expect(result.structuredContent).toMatchObject({ ok: true });
      const invalid = await client.callTool({ name: 'qbittorrent_delete_torrent', arguments: { hash: 'all', delete_files: true } });
      expect(invalid.isError).toBe(true);
      const typo = await client.callTool({ name: 'qbittorrent_delete_torrent', arguments: { hash, deleteFiles: true } });
      expect(typo.isError).toBe(true); expect(services.qbit.delete).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); }
  });

  it('does not infer VPN connection from accepted commands', async () => {
    const services = { connect: vi.fn().mockResolvedValue({ stdout: 'Connecting...', stderr: '', exitCode: 0 }), disconnect: vi.fn(), status: vi.fn().mockResolvedValue({ connected: false }) };
    const handlers = createVpnToolHandlers(config, services);
    expect(await handlers.vpn_connect({})).toMatchObject({ ok: false, error: { code: 'VPN_STATE_UNCONFIRMED' } });
    services.status.mockRejectedValueOnce(new McpError('VPN_UNSUPPORTED', 'fixture'));
    expect(await handlers.vpn_connect({})).toEqual({ ok: true, data: { connected: null, command_accepted: true, state_verified: false } });
    const server = createVpnServer(config, services); const client = new Client({ name: 'fixture', version: '1' });
    const [left, right] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(right); await client.connect(left);
      expect((await client.listTools()).tools).toHaveLength(5);
      const result = await client.callTool({ name: 'vpn_require_active', arguments: {} });
      expect(result.isError).toBe(true); expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'VPN_NOT_ACTIVE' } });
      const typo = await client.callTool({ name: 'vpn_connect', arguments: { county: 'Canada' } });
      expect(typo.isError).toBe(true);
    } finally { await client.close(); await server.close(); }
  });
});
