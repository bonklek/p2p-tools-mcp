import { describe, expect, it, vi } from 'vitest';
import { JackettClient } from './jackett-client.js';

describe('Jackett client', () => {
  it('sends typed search and pagination parameters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(`
      <rss><channel><item><title>Episode</title><torznab:attr name="seeders" value="4" /></item></channel></rss>
    `, { status: 200 }));
    const client = new JackettClient({ baseUrl: 'http://localhost:9117', apiKey: 'secret' }, fetchMock as typeof fetch);

    const result = await client.search({ query: 'show', searchType: 'tvsearch', season: 2, episode: '05', limit: 10, offset: 20 });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('t')).toBe('tvsearch');
    expect(url.searchParams.get('season')).toBe('2');
    expect(url.searchParams.get('ep')).toBe('05');
    expect(result).toMatchObject({ total: 1, limit: 10, offset: 20 });
  });

  it('never exposes an API key in connectivity errors', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('socket failed'));
    const client = new JackettClient({ baseUrl: 'http://localhost:9117', apiKey: 'very-secret-key' }, fetchMock as typeof fetch);

    const error = await client.search({ query: 'test' }).catch((value: unknown) => value);

    expect(error).toMatchObject({ code: 'JACKETT_UNREACHABLE' });
    expect(String(error)).not.toContain('very-secret-key');
  });

  it('returns a stable authentication error without response details', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('apikey=very-secret-key', { status: 403 }));
    const client = new JackettClient({ baseUrl: 'http://localhost:9117', apiKey: 'very-secret-key' }, fetchMock as typeof fetch);

    await expect(client.caps()).rejects.toMatchObject({ code: 'JACKETT_AUTH_FAILED', message: 'Jackett rejected the configured API key' });
  });
});
