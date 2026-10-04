import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from './shared/config.js';
import { loadConfigFromString } from './shared/config.js';
import type { ToolResult } from './shared/tool-result.js';
import { CLI_VERSION, runCli } from './cli-app.js';

type Handler = (args: unknown) => Promise<ToolResult>;

const config = loadConfigFromString('network_guard:\n  enabled: false\n');

function harness(options: {
  torrent?: Record<string, Handler>;
  vpn?: Record<string, Handler>;
  stdin?: string;
  loadConfig?: (env: NodeJS.ProcessEnv) => AppConfig;
} = {}) {
  let stdout = '';
  let stderr = '';
  const runtime = {
    env: {} as NodeJS.ProcessEnv,
    stdout: (text: string) => { stdout += text; },
    stderr: (text: string) => { stderr += text; },
    readStdin: async () => options.stdin ?? '',
    loadConfig: options.loadConfig ?? (() => config),
    ...(options.torrent === undefined ? {} : { torrentHandlers: () => options.torrent ?? {} }),
    ...(options.vpn === undefined ? {} : { vpnHandlers: () => options.vpn ?? {} })
  };
  return {
    run: (argv: string[]) => runCli(argv, runtime),
    stdout: () => stdout,
    stderr: () => stderr
  };
}

describe('p2p-tools CLI', () => {
  it('keeps the CLI version and all installed binaries in the package manifest', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
      bin: Record<string, string>;
    };

    expect(CLI_VERSION).toBe(manifest.version);
    expect(manifest.bin).toEqual({
      'p2p-tools': 'dist/p2p-tools.js',
      'vpn-mcp': 'dist/vpn-mcp.js',
      'torrent-mcp': 'dist/torrent-mcp.js',
      'p2p-tools-android': 'dist/android-cli.js',
      'p2p-tools-android-mcp': 'dist/android-mcp.js'
    });
  });

  it('prints help and version without loading configuration', async () => {
    const loadConfig = vi.fn(() => { throw new Error('must not run'); });
    const help = harness({ loadConfig });
    const version = harness({ loadConfig });

    await expect(help.run(['--help'])).resolves.toBe(0);
    await expect(version.run(['--version'])).resolves.toBe(0);

    expect(help.stdout()).toContain('p2p-tools <group> <action>');
    expect(version.stdout()).toBe(`${CLI_VERSION}\n`);
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it('maps command options to the canonical shared tool handler', async () => {
    const search = vi.fn(async () => ({ ok: true, data: { results: [] } } as const));
    const cli = harness({ torrent: { jackett_search: search } });

    const exitCode = await cli.run([
      'jackett', 'search', '--query', 'album', '--indexer=music',
      '--category', '3000,3010', '--category', '3040', '--season', '2', '--limit', '15'
    ]);

    expect(exitCode).toBe(0);
    expect(search).toHaveBeenCalledWith({
      query: 'album', indexer: 'music', categories: [3000, 3010, 3040], season: 2, limit: 15
    });
    expect(JSON.parse(cli.stdout())).toEqual({ ok: true, data: { results: [] } });
  });

  it('passes Soulseek filters and ranking preferences from private JSON input', async () => {
    const rank = vi.fn(async () => ({ ok: true, data: { ranked: [] } } as const));
    const cli = harness({
      stdin: JSON.stringify({
        search_id: 'ec435694-5c7d-11f1-9cf0-189341ab14ee',
        filters: { extensions: ['flac'], min_bit_depth: 24 },
        preferences: ['Prefer studio recordings'], preferred_users: ['trusted-peer']
      }),
      torrent: { slskd_rank: rank }
    });

    await expect(cli.run(['slskd', 'rank', '--stdin', '--limit', '8'])).resolves.toBe(0);
    expect(rank).toHaveBeenCalledWith({
      search_id: 'ec435694-5c7d-11f1-9cf0-189341ab14ee', limit: 8,
      filters: { extensions: ['flac'], min_bit_depth: 24 },
      preferences: ['Prefer studio recordings'], preferred_users: ['trusted-peer']
    });
  });

  it('runs a local command through the real shared operation layer', async () => {
    const cli = harness();

    const exitCode = await cli.run(['jackett', 'category', '--query', 'audio', '--compact']);

    expect(exitCode).toBe(0);
    const output = JSON.parse(cli.stdout());
    expect(output).toMatchObject({
      ok: true,
      data: { exact_matches: [{ id: 3000, name: 'Audio' }] }
    });
    expect(output.data.exact_matches[0].children[0].name).toBe('Audio/MP3');
  });

  it('supports qbit as an alias and merges private JSON input with explicit options', async () => {
    const add = vi.fn(async () => ({ ok: true, data: { added: true } } as const));
    const cli = harness({
      stdin: JSON.stringify({ magnet_uri: 'magnet:?xt=urn:btih:example', save_path: 'private-location', tags: ['one'] }),
      torrent: { qbittorrent_add_magnet: add }
    });

    const exitCode = await cli.run(['qbit', 'add-magnet', '--stdin', '--tag', 'two,three', '--paused']);

    expect(exitCode).toBe(0);
    expect(add).toHaveBeenCalledWith({
      magnet_uri: 'magnet:?xt=urn:btih:example', save_path: 'private-location', tags: ['two', 'three'], paused: true
    });
  });

  it('keeps path-bearing save locations off the command line', async () => {
    const cli = harness();

    await expect(cli.run([
      'qbit', 'add-magnet', '--save-path', 'private-location'
    ])).resolves.toBe(2);

    expect(cli.stderr()).not.toContain('private-location');
  });

  it('keeps magnet and torrent URLs off the command line', async () => {
    const magnet = harness();
    const torrent = harness();

    await expect(magnet.run([
      'qbit', 'add-magnet', '--magnet-uri', 'magnet:?xt=urn:btih:example&tr=https://tracker.invalid/token'
    ])).resolves.toBe(2);
    await expect(torrent.run([
      'qbit', 'add-url', '--torrent-url', 'https://example.invalid/file.torrent?token=canary'
    ])).resolves.toBe(2);

    expect(magnet.stderr()).not.toContain('tracker.invalid');
    expect(torrent.stderr()).not.toContain('canary');
  });

  it('requires explicit confirmation for deletion before loading configuration', async () => {
    const remove = vi.fn(async () => ({ ok: true, data: { deleted: 1 } } as const));
    const loadConfig = vi.fn(() => config);
    const cli = harness({ torrent: { qbittorrent_delete_torrent: remove }, loadConfig });

    const exitCode = await cli.run(['qbittorrent', 'delete', '--hash', 'abc']);

    expect(exitCode).toBe(2);
    expect(JSON.parse(cli.stderr())).toMatchObject({ ok: false, error: { code: 'CLI_USAGE' } });
    expect(remove).not.toHaveBeenCalled();
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it('passes confirmed delete arguments without the confirmation flag', async () => {
    const remove = vi.fn(async () => ({ ok: true, data: { deleted: 2 } } as const));
    const cli = harness({ torrent: { qbittorrent_delete_torrent: remove } });

    await expect(cli.run([
      'qbittorrent', 'delete', '--hash', 'abc,def', '--delete-files=false', '--yes'
    ])).resolves.toBe(0);

    expect(remove).toHaveBeenCalledWith({ hashes: ['abc', 'def'], delete_files: false });
  });

  it('rejects delete confirmation on non-delete commands', async () => {
    const status = vi.fn(async () => ({ ok: true, data: { connected: true } } as const));
    const cli = harness({ vpn: { vpn_status: status } });

    await expect(cli.run(['vpn', 'status', '--yes'])).resolves.toBe(2);

    expect(status).not.toHaveBeenCalled();
    expect(JSON.parse(cli.stderr()).error.code).toBe('CLI_USAGE');
  });

  it('rejects malformed input and unknown stdin fields as usage errors', async () => {
    const malformed = harness({ stdin: '{nope' });
    const unknown = harness({ stdin: JSON.stringify({ query: 'music', secret_field: 'canary' }) });

    await expect(malformed.run(['jackett', 'search', '--stdin'])).resolves.toBe(2);
    await expect(unknown.run(['jackett', 'search', '--stdin'])).resolves.toBe(2);

    expect(JSON.parse(malformed.stderr()).error.code).toBe('CLI_USAGE');
    expect(unknown.stderr()).not.toContain('secret_field');
    expect(unknown.stderr()).not.toContain('canary');
  });

  it('uses distinct exit codes for operation, configuration, and unexpected errors', async () => {
    const operation = harness({
      vpn: { vpn_status: async () => ({ ok: false, error: { code: 'VPN_COMMAND_FAILED', message: 'VPN command failed' } }) }
    });
    const configuration = harness({
      loadConfig: () => { throw new Error('C:\\Users\\private-user\\secret.yaml token=canary'); }
    });
    const unexpected = harness({
      vpn: { vpn_status: async () => { throw new Error('C:\\Users\\private-user\\token=canary'); } }
    });

    await expect(operation.run(['vpn', 'status'])).resolves.toBe(1);
    await expect(configuration.run(['vpn', 'status'])).resolves.toBe(2);
    await expect(unexpected.run(['vpn', 'status'])).resolves.toBe(1);

    expect(JSON.parse(operation.stdout()).error.code).toBe('VPN_COMMAND_FAILED');
    expect(JSON.parse(configuration.stderr())).toEqual({
      ok: false, error: { code: 'CONFIG_ERROR', message: 'CLI configuration failed' }
    });
    expect(JSON.parse(unexpected.stderr())).toEqual({
      ok: false, error: { code: 'CLI_ERROR', message: 'CLI operation failed' }
    });
    expect(configuration.stderr() + unexpected.stderr()).not.toContain('private-user');
    expect(configuration.stderr() + unexpected.stderr()).not.toContain('canary');
  });

  it('prints compact JSON when requested', async () => {
    const cli = harness({ vpn: { vpn_status: async () => ({ ok: true, data: { connected: true } }) } });

    await expect(cli.run(['vpn', 'status', '--compact'])).resolves.toBe(0);

    expect(cli.stdout()).toBe('{"ok":true,"data":{"connected":true}}\n');
  });

  it('plans a bulk manifest without loading configuration or contacting services', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'p2p-bulk-cli-'));
    try {
      const manifest = join(directory, 'songs.json');
      writeFileSync(manifest, JSON.stringify({ version: 1, tracks: [{ id: 'one', query: 'Artist Song' }] }));
      const loadConfig = vi.fn(() => { throw new Error('must not load'); });
      const cli = harness({ loadConfig });
      await expect(cli.run(['slskd', 'bulk', '--manifest', manifest, '--plan'])).resolves.toBe(0);
      expect(JSON.parse(cli.stdout())).toMatchObject({ ok: true, data: { mode: 'plan', tracks: 1 } });
      expect(loadConfig).not.toHaveBeenCalled();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
