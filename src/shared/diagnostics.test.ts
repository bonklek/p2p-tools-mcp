import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { validationError, publicDiagnostic } from './diagnostics.js';
import { loadConfigFromString } from './config.js';
import { McpError } from './errors.js';
import { createTorrentToolHandlers, type TorrentDeps } from '../torrent/server.js';
import { runCli } from '../cli-app.js';

describe('safe actionable diagnostics', () => {
  it('keeps hash-format guidance through list wrappers in the actual CLI', async () => {
    let output = '';
    expect(await runCli(['qbit', 'pause', '--hash', 'canary'], {
      env: { P2P_NETWORK_GUARD_ENABLED: 'false' }, stdout: (text) => { output += text; }
    })).toBe(2);
    expect(JSON.parse(output)).toMatchObject({ ok: false, error: { issues: [{ field: 'hashes', message: expect.stringContaining('40 or 64 hexadecimal') }] } });
    expect(output).not.toContain('canary');
  });
  it('reports schema constraints without echoing values or unknown field names', () => {
    const parsed = z.strictObject({ limit: z.number().int().min(1), filter: z.enum(['all', 'paused']) }).safeParse({ limit: 0, filter: 'canary-value', 'canary-field': 'canary' });
    if (parsed.success) throw Error('expected invalid input');
    const error = publicDiagnostic(validationError(parsed.error, { limit: undefined, filter: undefined }), 'fallback');
    expect(error.issues).toEqual([
      { field: 'limit', message: 'Must have a minimum of 1 (inclusive).' },
      { field: 'filter', message: 'Allowed values: all, paused.' },
      { field: 'arguments', message: 'Remove unknown fields; use the documented field names.' }
    ]);
    expect(JSON.stringify(error)).not.toContain('canary');
  });

  it('retains generic messages for untrusted ordinary errors', () => {
    const diagnostic = publicDiagnostic(new McpError('QBIT_REQUEST_FAILED', 'canary', { path: 'canary' }), 'Operation failed');
    expect(diagnostic.next_action).toContain('inspect torrent state');
    expect(JSON.stringify(diagnostic)).not.toContain('canary');
  });

  it('explains nested configuration fields and never includes unknown keys or supplied values', () => {
    for (const yaml of ['qbittorrent:\n  password: 123456789', 'network_guard:\n  guarded_operations: [canary]', 'jackett:\n  canary: canary']) {
      try { loadConfigFromString(yaml); throw Error('expected invalid config'); }
      catch (error) {
        expect(error).toBeInstanceOf(McpError);
        const diagnostic = publicDiagnostic(error as McpError, 'fallback');
        expect(diagnostic.issues?.length).toBeGreaterThan(0);
        expect(JSON.stringify(diagnostic)).not.toMatch(/canary|123456789/);
      }
    }
  });

  it('validates search relationships before probing the guard', async () => {
    const deps = { vpnStatusProvider: vi.fn(), jackett: { search: vi.fn() }, qbit: {} } as unknown as TorrentDeps;
    const result = await createTorrentToolHandlers(loadConfigFromString(''), deps).jackett_search({ season: 1 });
    expect(result).toMatchObject({ ok: false, error: { issues: [{ field: 'search_type', message: 'Use tvsearch with season or episode.' }] } });
    expect(deps.vpnStatusProvider).not.toHaveBeenCalled(); expect(deps.jackett.search).not.toHaveBeenCalled();
  });
});
