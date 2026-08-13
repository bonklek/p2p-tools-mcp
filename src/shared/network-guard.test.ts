import { describe, expect, it, vi } from 'vitest';
import { checkNetworkGuard } from './network-guard.js';
import { loadConfigFromString } from './config.js';

describe('network guard', () => {
  it('passes when disabled without calling provider', async () => {
    const config = loadConfigFromString('network_guard:\n  enabled: false\n');
    const provider = vi.fn();

    const result = await checkNetworkGuard(config, provider);

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('network_guard_disabled');
    expect(provider).not.toHaveBeenCalled();
  });

  it('passes when enabled and VPN is connected', async () => {
    const config = loadConfigFromString('network_guard:\n  enabled: true\n');
    const result = await checkNetworkGuard(config, async () => ({ connected: true, country: 'United States' }));

    expect(result.allowed).toBe(true);
    expect(result.status?.connected).toBe(true);
  });

  it('fails when enabled and VPN is disconnected', async () => {
    const config = loadConfigFromString('network_guard:\n  enabled: true\n');
    const result = await checkNetworkGuard(config, async () => ({ connected: false }));

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('vpn_not_connected');
  });

  it('skips provider for operations not configured for guarding', async () => {
    const config = loadConfigFromString('network_guard:\n  enabled: true\n  guarded_operations:\n    - torrent_add\n');
    const provider = vi.fn();

    const result = await checkNetworkGuard(config, provider, 'torrent_list');

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('operation_not_guarded');
    expect(provider).not.toHaveBeenCalled();
  });

  it('fails closed on provider errors', async () => {
    const config = loadConfigFromString('network_guard:\n  enabled: true\n');
    const result = await checkNetworkGuard(config, async () => { throw new Error('boom password=secret'); });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('status_provider_error');
    expect(result).not.toHaveProperty('error');
  });
});
