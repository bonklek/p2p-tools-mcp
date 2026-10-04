import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPublicIp } from './public-ip.js';

afterEach(() => vi.unstubAllGlobals());
describe('public IP validation', () => {
  it.each(['203.0.113.2', '2001:db8::1'])('accepts valid JSON and text %s', async (ip) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ip }))).mockResolvedValueOnce(new Response(` ${ip}\n`)));
    await expect(getPublicIp()).resolves.toEqual({ ip }); await expect(getPublicIp()).resolves.toEqual({ ip });
  });
  it.each(['{}', '{"ip":123}', '{"ip":{}}', '{"ip":null}', 'null', '[]', '<html>proxy</html>', 'not an ip', '', '{"ip":"999.1.1.1"}'])('rejects %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
    await expect(getPublicIp()).rejects.toMatchObject({ code: 'PUBLIC_IP_FAILED' });
  });
  it('uses stable errors for fetch failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('password=canary')));
    await expect(getPublicIp()).rejects.toMatchObject({ code: 'PUBLIC_IP_FAILED', message: 'Public IP lookup failed' });
  });
});
