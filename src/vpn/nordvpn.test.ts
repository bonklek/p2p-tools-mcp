import { describe, expect, it, vi } from 'vitest';
import { NordVpnClient, commandEnvironment, connectArgs, disconnectArgs, parseNordVpnStatus, requireActiveVpn, statusArgs } from './nordvpn.js';
import { McpError } from '../shared/errors.js';

describe('NordVPN adapter', () => {
  it('parses connected status', () => {
    const status = parseNordVpnStatus(`
Status: Connected
Hostname: us1234.nordvpn.com
Country: United States
City: New York
Current technology: NORDLYNX
Current protocol: UDP
Transfer: 1.2 MiB received, 3.4 MiB sent
`);

    expect(status.connected).toBe(true);
    expect(status.country).toBe('United States');
    expect(status.city).toBe('New York');
    expect(status.server).toBe('us1234.nordvpn.com');
  });

  it('parses disconnected status', () => {
    expect(parseNordVpnStatus('Status: Disconnected').connected).toBe(false);
  });

  it.each([true, false])('reads protected=%s from NordVPN public egress on Windows', async (protectedEgress) => {
    const runner = vi.fn();
    const fetcher = vi.fn(async (url, init) => {
      expect(url).toBe('https://api.nordvpn.com/v1/helpers/ips/insights');
      expect(init?.redirect).toBe('error');
      return new Response(JSON.stringify({ protected: protectedEgress, ip: 'fixture' }));
    }) as typeof fetch;
    const client = new NordVpnClient({ command: 'nordvpn', platform: 'win32', windowsStatusProvider: 'nord-egress', timeoutMs: 1000 }, runner, fetcher);
    expect(await client.status()).toEqual({ connected: protectedEgress });
    expect(runner).not.toHaveBeenCalled();
  });

  it('fails closed on malformed or unavailable Windows egress status', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ protected: 'yes', ip: 'private' }))) as typeof fetch;
    const client = new NordVpnClient({ command: 'nordvpn', platform: 'win32', windowsStatusProvider: 'nord-egress', timeoutMs: 1000 }, vi.fn(), fetcher);
    await expect(client.status()).rejects.toMatchObject({ code: 'VPN_STATUS_UNKNOWN' });
  });

  it('builds connect args with optional country', async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: 'Connecting...', stderr: '', exitCode: 0 });
    const client = new NordVpnClient({ command: 'nordvpn', platform: 'linux' }, runner);

    await client.connect('United_States');

    expect(runner).toHaveBeenCalledWith('nordvpn', connectArgs('United_States', 'linux'), expect.objectContaining({ env: expect.any(Object) }));
  });

  it('uses platform-specific command dialects', () => {
    expect(connectArgs('United_States', 'linux')).toEqual(['connect', 'United_States']);
    expect(connectArgs('United_States', 'win32')).toEqual(['-c', '--group-name', 'United States']);
    expect(disconnectArgs('win32')).toEqual(['-d']);
    expect(() => connectArgs('', 'darwin')).toThrow(McpError);
    expect(() => disconnectArgs('darwin')).toThrow(McpError);
    expect(statusArgs('linux')).toEqual(['status']);
    expect(() => statusArgs('darwin')).toThrow(McpError);
    expect(() => statusArgs('win32')).toThrow(McpError);
  });

  it('passes only a minimal non-secret environment to the VPN child', () => {
    const env = commandEnvironment({ PATH: 'private-bin', SystemRoot: 'windows', JACKETT_API_KEY: 'canary', P2P_TOOLS_CONFIG: 'private' }, 'win32');
    expect(JSON.stringify(env)).not.toContain('canary');
    expect(JSON.stringify(env)).not.toContain('private');
    expect(env.SystemRoot).toBe('windows');
  });

  it('throws an MCP error on command failure with redacted output', async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: '', stderr: 'password=secret failed', exitCode: 1 });
    const client = new NordVpnClient({ command: 'nordvpn', platform: 'linux' }, runner);

    await expect(client.disconnect()).rejects.toMatchObject({ code: 'VPN_COMMAND_FAILED' });
    await expect(client.disconnect()).rejects.not.toThrow('secret');
  });

  it('requires active VPN when configured', () => {
    expect(() => requireActiveVpn({ connected: true })).not.toThrow();
    expect(() => requireActiveVpn({ connected: false })).toThrow(McpError);
  });
});
