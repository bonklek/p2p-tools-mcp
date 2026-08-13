import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfigFromString, loadConfigFromEnv } from './config.js';
import { redactConfig, redactValue } from './redact.js';

describe('config loader', () => {
  it('returns safe platform-agnostic local defaults', () => {
    const config = loadConfigFromString('');

    expect(config.vpn.provider).toBe('nordvpn');
    expect(config.vpn.command).toBe('nordvpn');
    expect(config.networkGuard.enabled).toBe(true);
    expect(config.networkGuard.requireVpnConnected).toBe(true);
    expect(config.networkGuard.guardedOperations).toEqual(['torrent_search', 'torrent_caps', 'torrent_list_indexers', 'torrent_add']);
    expect(config.jackett.baseUrl).toBe('http://127.0.0.1:9117');
    expect(config.qbittorrent.baseUrl).toBe('http://127.0.0.1:8080');
    expect(config.timeouts.commandMs).toBe(15000);
  });

  it('parses YAML and merges with defaults', () => {
    const config = loadConfigFromString(`
vpn:
  command: /usr/bin/nordvpn
  defaultCountry: United_States
network_guard:
  enabled: false
  guarded_operations:
    - torrent_list
jackett:
  apiKey: secret-jackett-key
qbittorrent:
  username: admin
  password: super-secret
`);

    expect(config.vpn.command).toBe('/usr/bin/nordvpn');
    expect(config.vpn.defaultCountry).toBe('United_States');
    expect(config.networkGuard.enabled).toBe(false);
    expect(config.networkGuard.guardedOperations).toEqual(['torrent_list']);
    expect(config.jackett.apiKey).toBe('secret-jackett-key');
    expect(config.qbittorrent.username).toBe('admin');
    expect(config.qbittorrent.password).toBe('super-secret');
    expect(config.qbittorrent.baseUrl).toBe('http://127.0.0.1:8080');
  });

  it('loads config path from environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p2p-tools-config-'));
    const file = join(dir, 'config.yaml');
    writeFileSync(file, 'vpn:\n  command: custom-vpn\n');

    expect(loadConfigFromEnv({ P2P_TOOLS_CONFIG: file }).vpn.command).toBe('custom-vpn');
  });

  it('supports legacy Jackett and qBittorrent environment variables', () => {
    const config = loadConfigFromEnv({
      JACKETT_BASE_URL: 'http://jackett.test:9117',
      JACKETT_API_KEY: 'jackett-key',
      QBITTORRENT_BASE_URL: 'http://qbit.test:8080',
      QBITTORRENT_USERNAME: 'admin',
      QBITTORRENT_PASSWORD: 'password',
      P2P_NETWORK_GUARD_ENABLED: 'false'
    });

    expect(config.jackett).toMatchObject({ baseUrl: 'http://jackett.test:9117', apiKey: 'jackett-key' });
    expect(config.qbittorrent).toMatchObject({ baseUrl: 'http://qbit.test:8080', username: 'admin', password: 'password' });
    expect(config.networkGuard.enabled).toBe(false);
  });

  it('reports a missing config path from the environment', () => {
    const env = { P2P_TOOLS_CONFIG: '/tmp/missing.yaml' };

    expect(() => loadConfigFromEnv(env, () => 'unused')).toThrowError('Configured P2P_TOOLS_CONFIG file was not found');
  });

  it('redacts credentials in values and config objects', () => {
    expect(redactValue('token=abc123 password=secret')).not.toContain('abc123');
    expect(redactValue('token=abc123 password=secret')).not.toContain('secret');
    const redactedText = redactValue('passphrase=secret api_key=key apikey=key2 authorization=Bearer cookie=session sid=123 auth=basic');
    expect(redactedText).toContain('<redacted>');
    expect(redactedText).not.toContain('key2');
    expect(redactedText).not.toContain('session');
    expect(redactedText).not.toContain('basic');

    const redacted = redactConfig({
      jackett: { apiKey: 'secret-jackett-key' },
      qbittorrent: { password: 'super-secret', sid: 'sid-value' },
      headers: { authorization: 'Bearer abc', cookie: 'session=abc' }
    });

    expect(redacted.jackett.apiKey).toBe('<redacted>');
    expect(redacted.qbittorrent.password).toBe('<redacted>');
    expect(redacted.qbittorrent.sid).toBe('<redacted>');
    expect(redacted.headers.authorization).toBe('<redacted>');
    expect(redacted.headers.cookie).toBe('<redacted>');

    const formats = redactValue('password: "canary" {"apiKey":"canary"} --token canary https://user:canary@localhost <secret>canary</secret>');
    expect(formats).not.toContain('canary');
    const windowsPath = ['C:', 'Users', 'sample-user', 'private', 'config.yaml'].join('\\');
    const unixPath = ['', 'home', 'sample-user', 'private', 'config.yaml'].join('/');
    expect(redactValue(`failed at ${windowsPath} and ${unixPath}`)).not.toContain('sample-user');
    const bypasses = redactValue('Authorization: Bearer canary Authorization: Basic canary api_key = canary api%5Fkey=canary at /opt/app/config.yaml /Volumes/private/config.yaml');
    expect(bypasses).not.toContain('canary');
    expect(bypasses).not.toContain('/opt/app');
    expect(bypasses).not.toContain('/Volumes/private');
    const relatives = redactValue('failed at ../private/config.yaml and private\\config.yaml and ./local/settings.yml');
    expect(relatives).not.toContain('private');
    expect(relatives).not.toContain('settings.yml');
    expect(redactConfig({ path: 'private/config.yaml', command: '..\\bin\\tool.exe' })).toEqual({
      path: '<redacted-path>',
      command: '<redacted-path>'
    });
    const oauth = redactValue('api-key=canary access_token=canary refresh-token=canary client_secret=canary X-API-Key: canary ?access-token=canary access%5Ftoken%3Dcanary');
    expect(oauth).not.toContain('canary');
    expect(redactConfig({ apiKey: 'canary', 'api-key': 'canary', access_token: 'canary', refreshToken: 'canary', client_secret: 'canary' })).toEqual({
      apiKey: '<redacted>',
      'api-key': '<redacted>',
      access_token: '<redacted>',
      refreshToken: '<redacted>',
      client_secret: '<redacted>'
    });
    const spaced = redactValue('secret="first canary last"\napi-key: "first canary last"\n--client-secret "first canary last"\nX-API-Key: first canary last');
    expect(spaced).not.toContain('canary');
    const inline = redactValue('provider failed with api-key: first canary last');
    expect(inline).not.toContain('canary');
    const namespaced = redactConfig({ vendor_api_key: 'canary', databaseUrl: 'postgres://dbuser:canary@127.0.0.1/app' });
    expect(JSON.stringify(namespaced)).not.toContain('canary');
    expect(redactValue('failed at file:///var/app/private/config.yaml')).not.toContain('/var/app');
    const privateKey = ['-----BEGIN ', 'PRIVATE KEY-----\ncanary\n-----END ', 'PRIVATE KEY-----'].join('');
    const hostile = redactValue(`vendor.password=canary cloud_access_key=canary <vendor_token>canary</vendor_token> Bearer canary ${privateKey}`);
    expect(hostile).not.toContain('canary');
    expect(redactConfig({ provider_save_path: 'private file.dat', source_filename: 'private name.txt', signing_key: 'canary' })).toEqual({
      provider_save_path: '<redacted-path>', source_filename: '<redacted-path>', signing_key: '<redacted>'
    });
    const camelCase = redactConfig({ providerApiKey: 'canary', providerSavePath: 'private name.txt', targetFile: 'private.dat' });
    expect(JSON.stringify(camelCase)).not.toContain('canary');
    expect(JSON.stringify(camelCase)).not.toContain('private');
    expect(redactValue('provider.password canary\nprovider.apiKey=canary')).not.toContain('canary');
    expect(redactValue('host local provider.api.key canary\n<provider.api.key>canary</provider.api.key>\nprovider.api.key%3Dcanary')).not.toContain('canary');
    expect(redactValue('password canary\nmachine local login guest password canary')).not.toContain('canary');
    expect(redactValue('%61%70%69%2D%6B%65%79%3Dcanary')).not.toContain('canary');
    expect(redactValue('{"api\\u002dkey":"canary"}')).not.toContain('canary');
    expect(redactValue('%zz%61%70%69%2D%6B%65%79%3Dcanary')).not.toContain('canary');
    expect(redactValue('%61%70%69%2D%6B%65%79%3Dcanary%zz')).not.toContain('canary');
    let nested = 'api-key=canary';
    for (let index = 0; index < 20; index += 1) nested = encodeURIComponent(nested);
    expect(redactValue(nested)).not.toContain('canary');
    const started = performance.now();
    expect(redactValue('x'.repeat(100_000))).toBe('<redacted>');
    expect(performance.now() - started).toBeLessThan(100);
  });
});
