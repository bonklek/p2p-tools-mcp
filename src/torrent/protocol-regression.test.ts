import { createServer, type RequestListener } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { QbitClient } from './qbit-client.js';
import { JackettClient } from './jackett-client.js';
import { normalizeJackettCaps, normalizeJackettSearch } from './jackett-normalize.js';

// Semantic fixtures: qBittorrent release-4.6.7/release-5.0.0 torrentscontroller.cpp
// and torrentfilter.cpp; Jackett TorznabCapabilities.cs / ResultsController.cs.
describe('upstream response contracts', () => {
  it.each(['Fails.', '', '<html>proxy error</html>'])('does not report add success for %j', async (body) => {
    const fetcher = vi.fn(async (url: string) => url.endsWith('/auth/login')
      ? new Response('Ok.', { headers: { 'set-cookie': 'SID=fixture; Path=/' } }) : new Response(body));
    const client = new QbitClient({ baseUrl: 'http://fixture.invalid' }, fetcher as typeof fetch);
    await expect(client.add({ urls: ['https://fixture.invalid/a.torrent'] })).rejects.toMatchObject({ code: 'QBIT_REQUEST_FAILED' });
  });

  it.each([4, 5])('preserves paused add intent for qBittorrent %i', async (major) => {
    let observed: FormData | undefined;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/auth/login')) return new Response('Ok.', { headers: { 'set-cookie': 'SID=fixture' } });
      observed = init?.body as FormData;
      return new Response(observed.get(major === 4 ? 'paused' : 'stopped') === 'true' ? 'Ok.' : 'Fails.');
    });
    await expect(new QbitClient({ baseUrl: 'http://fixture.invalid' }, fetcher as typeof fetch).add({ urls: ['https://fixture.invalid/a.torrent'], paused: true })).resolves.toEqual({ ok: true });
    expect(observed?.get(major === 4 ? 'paused' : 'stopped')).toBe('true');
  });

  it.each([4, 5])('uses the correct paused filter for qBittorrent %i and caches version', async (major) => {
    const filters: Array<string | null> = [];
    let versionCalls = 0;
    const fetcher = vi.fn(async (value: string) => {
      const url = new URL(value);
      if (url.pathname.endsWith('/auth/login')) return new Response('Ok.', { headers: { 'set-cookie': 'SID=fixture' } });
      if (url.pathname.endsWith('/app/version')) { versionCalls++; return new Response(`v${major}.0.0`); }
      filters.push(url.searchParams.get('filter'));
      return new Response('[]');
    });
    const client = new QbitClient({ baseUrl: 'http://fixture.invalid' }, fetcher as typeof fetch);
    await client.list({ filter: 'paused' }); await client.list({ filter: 'paused' });
    expect(filters).toEqual([major === 4 ? 'paused' : 'stopped', major === 4 ? 'paused' : 'stopped']);
    expect(versionCalls).toBe(1);
  });

  it('retains empty category and tag filters', async () => {
    let requestUrl = '';
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/auth/login')) return new Response('Ok.', { headers: { 'set-cookie': 'SID=fixture' } });
      requestUrl = url; return new Response('[]');
    });
    await new QbitClient({ baseUrl: 'http://fixture.invalid' }, fetcher as typeof fetch).list({ category: '', tag: '' });
    expect(new URL(requestUrl).searchParams.has('category')).toBe(true);
    expect(new URL(requestUrl).searchParams.has('tag')).toBe(true);
  });

  it('reads upstream hyphenated capability elements', () => {
    expect(normalizeJackettCaps('<caps><searching><search available="yes"/><tv-search available="yes"/><movie-search available="yes"/><music-search available="no"/><book-search available="yes"/></searching></caps>').searching)
      .toEqual({ search: true, tvsearch: true, movie: true, music: false, book: true });
  });

  it.each(['<error code="100" description="canary"/>', '<html>proxy</html>', '<rss/>', '<rss><channel>wrong shape</channel></rss>'])('rejects non-search XML: %s', (xml) => {
    expect(() => normalizeJackettSearch(xml)).toThrowError();
    try { normalizeJackettSearch(xml); } catch (error) { expect(String(error)).not.toContain('canary'); }
  });

  it('retains legitimate empty RSS and maps HTTP-200 service errors', async () => {
    expect(normalizeJackettSearch('<rss><channel/></rss>')).toEqual([]);
    const client = new JackettClient({ baseUrl: 'http://fixture.invalid' }, vi.fn(async () => new Response('<error code="100" description="canary"/>')) as typeof fetch);
    await expect(client.search({})).rejects.toMatchObject({ code: 'JACKETT_AUTH_FAILED' });
  });

  it('rejects scalar caps, duplicate channels, and scalar items', () => {
    expect(() => normalizeJackettCaps('<caps>proxy error</caps>')).toThrowError();
    expect(() => normalizeJackettSearch('<rss><channel/><channel/></rss>')).toThrowError();
    expect(() => normalizeJackettSearch('<rss><channel><item>proxy error</item></channel></rss>')).toThrowError();
    expect(() => normalizeJackettSearch('<rss><channel><item/></channel></rss>')).toThrowError();
  });
});

async function withServer(listener: RequestListener, run: (url: string) => Promise<void>) {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

describe('real Fetch failure boundaries on loopback fixtures', () => {
  it.each(['login', 'body'])('times out a stalled %s body', async (stage) => {
    await withServer((req, res) => {
      if (stage === 'body' && req.url?.endsWith('/auth/login')) { res.setHeader('set-cookie', 'SID=fixture'); res.end('Ok.'); return; }
      res.writeHead(200, { 'content-type': 'text/plain' }); res.write(' ');
    }, async (baseUrl) => {
      await expect(new QbitClient({ baseUrl, timeoutMs: 100 }).list()).rejects.toMatchObject({ code: 'QBIT_UNREACHABLE' });
    });
  }, 2000);

  it.each([307, 308])('does not forward credentials on a %i redirect', async (status) => {
    let leakedRequests = 0;
    await withServer((_req, res) => { leakedRequests++; res.end('Ok.'); }, async (otherOrigin) => {
      await withServer((_req, res) => { res.writeHead(status, { Location: otherOrigin }); res.end(); }, async (baseUrl) => {
        await expect(new QbitClient({ baseUrl, username: 'fixture', password: 'canary', timeoutMs: 500 }).list()).rejects.toMatchObject({ code: 'QBIT_UNREACHABLE' });
        await expect(new JackettClient({ baseUrl, apiKey: 'canary', timeoutMs: 500 }).search({})).rejects.toMatchObject({ code: 'JACKETT_UNREACHABLE' });
      });
    });
    expect(leakedRequests).toBe(0);
  });
});
