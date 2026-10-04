import { describe, expect, it } from 'vitest';
import { loadConfigFromEnv, loadConfigFromString } from './config.js';

describe('configuration rejects unsafe ambiguity', () => {
  it.each([
    'network_guard:\n  enabled: null', 'network_guard:\n  enabled: 0',
    'network_guard:\n  enabled: "false"', 'network_guard:\n  requireVpnConnected: 0',
    'network_guard:\n  guarded_operations: [jackett_search]', 'network_guard:\n  guarded_operations: [torrent_ad]',
    'network_guard:\n  guarded_operations: null', 'network_guard:\n  require_vpn_connected: false',
    'network_guard: false', 'vpn: []', 'jackett: null', 'timeouts:\n  httpMs: .nan',
    'timeouts:\n  httpMs: .inf', 'timeouts:\n  httpMs: "100"', 'timeouts:\n  commandMs: 0',
    'timeouts:\n  httpMs: 2147483648', 'timeouts:\n  httpMs: 0.5', 'qbittorrent:\n  password: 123',
    'vpn:\n  command: 123', 'jackett:\n  baseUrl: file:///private',
    'jackett:\n  baseUrl: https://user:canary@example.invalid',
    'qbittorrent:\n  baseUrl: http://localhost:8080?password=canary',
    'network_guard: {}\nnetworkGuard: {}', 'network_guard:\n  guarded_operations: []\n  guardedOperations: []'
  ])('rejects malformed settings: %s', (yaml) => {
    expect(() => loadConfigFromString(yaml)).toThrowError();
    try { loadConfigFromString(yaml); } catch (error) { expect(error).toMatchObject({ code: 'CONFIG_INVALID' }); }
  });

  it('retains deliberate opt-outs, supported aliases and endpoint path prefixes', () => {
    const config = loadConfigFromString('networkGuard:\n  enabled: false\n  requireVpnConnected: false\n  guardedOperations: []\njackett:\n  baseUrl: https://example.invalid/jackett');
    expect(config.networkGuard).toEqual({ enabled: false, requireVpnConnected: false, guardedOperations: [] });
    expect(config.jackett.baseUrl).toBe('https://example.invalid/jackett');
  });

  it.each(['NaN', 'Infinity', '0', '-1', '0.5', '2147483648'])('rejects invalid env timeout %s', (value) => {
    expect(() => loadConfigFromEnv({ P2P_HTTP_TIMEOUT_MS: value })).toThrowError();
  });
});
