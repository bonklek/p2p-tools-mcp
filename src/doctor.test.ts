import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDoctorReport } from './doctor.js';
import { loadConfigFromString } from './shared/config.js';
import { McpError } from './shared/errors.js';
import { createTorrentServer, createTorrentToolHandlers, type TorrentDeps } from './torrent/server.js';
import { runCli } from './cli-app.js';

function services(): TorrentDeps {
  return {
    jackett: { search: vi.fn(), caps: vi.fn(), listIndexers: vi.fn(), testConnection: vi.fn().mockResolvedValue({ connected: true, api_key_valid: true, torznab_ok: true, admin_api_ok: true, indexers_configured: 1, warnings: [] }) },
    qbit: { add: vi.fn(), list: vi.fn(), get: vi.fn(), pause: vi.fn(), resume: vi.fn(), delete: vi.fn(), testConnection: vi.fn().mockResolvedValue({ reachable: true, authenticated: true, version: 'v5.1.0' }) },
    vpnStatusProvider: vi.fn().mockResolvedValue({ connected: true })
  };
}
const config = loadConfigFromString('');

describe('read-only doctor', () => {
  it('reports access and guard observations without claiming traffic isolation or invoking mutations', async () => {
    const deps = services();
    const report = await createDoctorReport(config, deps);
    expect(report.status).toBe('checks_passed');
    expect(report.checks.map((check) => check.status)).toEqual(['passed', 'passed', 'passed', 'passed', 'not_checked']);
    expect(report.checks[4].message).toContain('not verified');
    for (const fn of [deps.jackett.search, deps.jackett.caps, deps.jackett.listIndexers, deps.qbit.add, deps.qbit.list, deps.qbit.get, deps.qbit.pause, deps.qbit.resume, deps.qbit.delete]) expect(fn).not.toHaveBeenCalled();
  });

  it('completes independent checks after failures and emits safe recovery guidance', async () => {
    const deps = services();
    vi.mocked(deps.jackett.testConnection).mockRejectedValue(new McpError('JACKETT_AUTH_FAILED', 'canary C:\\private\\config', { credentials: 'canary' }));
    vi.mocked(deps.vpnStatusProvider).mockRejectedValue(new McpError('VPN_UNSUPPORTED', 'canary'));
    const result = await createTorrentToolHandlers(config, deps).p2p_doctor({});
    expect(result).toMatchObject({ ok: true, data: { status: 'blocked', checks: expect.arrayContaining([
      expect.objectContaining({ name: 'jackett', status: 'failed', next_action: expect.stringContaining('credentials') }),
      expect.objectContaining({ name: 'qbittorrent', status: 'passed' }),
      expect.objectContaining({ name: 'network_guard', status: 'failed', next_action: expect.stringContaining('Linux') })
    ]) } });
    expect(JSON.stringify(result)).not.toMatch(/canary|private|<redacted/);
  });

  it.each(['network_guard:\n  enabled: false', 'network_guard:\n  guarded_operations: []'])('skips host inspection when no operations are guarded', async (yaml) => {
    const deps = services();
    const report = await createDoctorReport(loadConfigFromString(yaml), deps);
    expect(report.status).toBe('attention_needed');
    expect(deps.vpnStatusProvider).not.toHaveBeenCalled();
  });

  it('matches guard behavior when connected state is optional but status inspection fails', async () => {
    const deps = services();
    vi.mocked(deps.vpnStatusProvider).mockRejectedValue(new Error('canary'));
    expect((await createDoctorReport(loadConfigFromString('network_guard:\n  requireVpnConnected: false'), deps)).status).toBe('blocked');
  });

  it('warns on incomplete indexer and version evidence without echoing service data', async () => {
    const deps = services();
    vi.mocked(deps.jackett.testConnection).mockResolvedValue({ connected: true, api_key_valid: true, torznab_ok: true, response_time_ms: 1, admin_api_ok: false, indexers_configured: null, warnings: ['canary'] });
    vi.mocked(deps.qbit.testConnection).mockResolvedValue({ reachable: true, authenticated: true, version: 'canary' });
    const report = await createDoctorReport(config, deps);
    expect(report.status).toBe('attention_needed');
    expect(report.checks.filter((check) => check.status === 'warning')).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain('canary');
  });

  it.each([true, false])('shares the report over CLI and MCP; connected=%s', async (connected) => {
    const deps = services();
    vi.mocked(deps.vpnStatusProvider).mockResolvedValue({ connected });
    let output = '';
    const exit = await runCli(['doctor', '--compact'], { loadConfig: () => config, stdout: (text) => { output += text; }, torrentHandlers: () => createTorrentToolHandlers(config, deps) });
    expect(exit).toBe(connected ? 0 : 1);
    expect(output.trim().split('\n')).toHaveLength(1);
    const server = createTorrentServer(config, deps);
    const client = new Client({ name: 'doctor-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      expect((await client.listTools()).tools.find((tool) => tool.name === 'p2p_doctor')?.annotations?.readOnlyHint).toBe(true);
      const result = await client.callTool({ name: 'p2p_doctor', arguments: {} });
      expect(result.structuredContent).toEqual(JSON.parse(output));
      expect(result.isError).not.toBe(true);
    } finally { await client.close(); await server.close(); }
  });

  it('shows help and rejects unknown flags before loading configuration', async () => {
    const loadConfig = vi.fn(() => { throw Error('must not run'); });
    const readStdin = vi.fn();
    const runtime = { loadConfig, readStdin, stdout: vi.fn(), stderr: vi.fn() };
    expect(await runCli(['doctor', '--help'], runtime)).toBe(0);
    for (const flag of ['--unknown', '--stdin', '--yes']) expect(await runCli(['doctor', flag], runtime)).toBe(2);
    expect(loadConfig).not.toHaveBeenCalled(); expect(readStdin).not.toHaveBeenCalled();
  });

  it('returns actionable configuration errors before constructing services', async () => {
    const torrentHandlers = vi.fn(); let output = '';
    const exit = await runCli(['doctor'], { env: { QBITTORRENT_BASE_URL: 'https://user:canary@invalid' }, torrentHandlers, stderr: (text) => { output += text; } });
    expect(exit).toBe(2); expect(torrentHandlers).not.toHaveBeenCalled();
    expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: 'CONFIG_INVALID', issues: [{ field: 'qbittorrent.baseUrl', message: expect.stringContaining('HTTP(S)') }], next_action: expect.any(String) } });
    expect(output).not.toContain('canary');
  });
});
