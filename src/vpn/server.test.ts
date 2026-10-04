import { describe, expect, it, vi } from 'vitest';
import { loadConfigFromString } from '../shared/config.js';
import { createVpnToolHandlers } from './server.js';

describe('VPN shared tool handlers', () => {
  it('validates arguments before invoking the client', async () => {
    const client = fakeClient();
    const handlers = createVpnToolHandlers(loadConfigFromString(''), client);

    const result = await handlers.vpn_connect({ country: '' });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT', issues: [{ field: 'country', message: expect.stringContaining('1') }], next_action: expect.any(String) }
    });
    expect(client.connect).not.toHaveBeenCalled();
  });

  it('uses the configured default country and returns the shared result envelope', async () => {
    const client = fakeClient();
    const config = loadConfigFromString('vpn:\n  defaultCountry: Canada\n');
    const handlers = createVpnToolHandlers(config, client);

    const result = await handlers.vpn_connect({});

    expect(client.connect).toHaveBeenCalledWith('Canada');
    expect(result).toEqual({ ok: true, data: { connected: true, command_accepted: true, state_verified: true } });
  });

  it('redacts successful data and converts unexpected failures to fixed errors', async () => {
    const client = fakeClient();
    client.status
      .mockResolvedValueOnce({ connected: true, note: 'token=canary', path: 'C:\\Users\\private-user\\vpn.conf' })
      .mockRejectedValueOnce(new Error('token=canary at C:\\Users\\private-user\\vpn.conf'));
    const handlers = createVpnToolHandlers(loadConfigFromString(''), client);

    const success = await handlers.vpn_status({});
    const failure = await handlers.vpn_status({});

    expect(JSON.stringify(success)).not.toContain('canary');
    expect(JSON.stringify(success)).not.toContain('private-user');
    expect(failure).toEqual({
      ok: false,
      error: { code: 'TOOL_ERROR', message: 'The tool operation failed' }
    });
  });
});

function fakeClient() {
  return {
    status: vi.fn().mockResolvedValue({ connected: true }),
    connect: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    disconnect: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }))
  };
}
