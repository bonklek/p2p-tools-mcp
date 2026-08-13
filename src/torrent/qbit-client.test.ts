import { describe, expect, it, vi } from 'vitest';
import { QbitClient } from './qbit-client.js';

describe('qBittorrent Web API client', () => {
  it('logs in and reuses SID cookie for list requests', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=abc123; Path=/' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ hash: 'h1', name: 'Ubuntu', state: 'downloading' }]), { status: 200 }));
    const client = new QbitClient({ baseUrl: 'http://127.0.0.1:8080', username: 'admin', password: 'secret', timeoutMs: 1000 }, fetchMock as typeof fetch);

    const torrents = await client.list();

    expect(torrents).toEqual([expect.objectContaining({ hash: 'h1', name: 'Ubuntu', state: 'downloading', tags: [] })]);
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:8080/api/v2/auth/login', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:8080/api/v2/torrents/info', expect.objectContaining({ headers: expect.objectContaining({ Cookie: 'SID=abc123' }) }));
  });

  it('adds a torrent URL with paused and savepath options', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=abc123; Path=/' } }))
      .mockResolvedValueOnce(new Response('Ok.', { status: 200 }));
    const client = new QbitClient({ baseUrl: 'http://localhost:8080', username: 'u', password: 'p' }, fetchMock as typeof fetch);

    await client.add({ urls: ['magnet:?xt=urn:btih:abc'], paused: true, savepath: '/downloads' });

    const body = fetchMock.mock.calls[1][1].body as FormData;
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:8080/api/v2/torrents/add');
    expect(body.get('urls')).toBe('magnet:?xt=urn:btih:abc');
    expect(body.get('paused')).toBe('true');
    expect(body.get('savepath')).toBe('/downloads');
  });

  it('calls pause, resume, and delete endpoints with hashes', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=sid; Path=/' } })));
    const client = new QbitClient({ baseUrl: 'http://localhost:8080', username: 'u', password: 'p' }, fetchMock as typeof fetch);

    await client.pause(['h1']);
    await client.resume(['h1']);
    await client.delete(['h1'], true);

    expect(fetchMock.mock.calls.map((call) => call[0])).toContain('http://localhost:8080/api/v2/torrents/stop');
    expect(fetchMock.mock.calls.map((call) => call[0])).toContain('http://localhost:8080/api/v2/torrents/start');
    expect(fetchMock.mock.calls.map((call) => call[0])).toContain('http://localhost:8080/api/v2/torrents/delete');
  });

  it('throws a redacted error on login failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('password=secret denied', { status: 403 }));
    const client = new QbitClient({ baseUrl: 'http://localhost:8080', username: 'u', password: 'secret' }, fetchMock as typeof fetch);

    await expect(client.list()).rejects.toMatchObject({ code: 'QBIT_LOGIN_FAILED' });
    await expect(client.list()).rejects.not.toThrow('secret');
  });

  it('re-authenticates once when a session expires', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=old; Path=/' } }))
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
      .mockResolvedValueOnce(new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=new; Path=/' } }))
      .mockResolvedValueOnce(new Response('[]', { status: 200 }));
    const client = new QbitClient({ baseUrl: 'http://localhost:8080', username: 'u', password: 'p' }, fetchMock as typeof fetch);

    await expect(client.list()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3][1].headers.Cookie).toBe('SID=new');
  });

  it('falls back to qBittorrent 4 pause endpoint when stop is unavailable', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=sid; Path=/' } }))
      .mockResolvedValueOnce(new Response('Not found', { status: 404 }))
      .mockResolvedValueOnce(new Response('Ok.', { status: 200 }));
    const client = new QbitClient({ baseUrl: 'http://localhost:8080', username: 'u', password: 'p' }, fetchMock as typeof fetch);

    await client.pause(['h1']);
    expect(fetchMock.mock.calls[2][0]).toBe('http://localhost:8080/api/v2/torrents/pause');
  });

  it('returns normalized summary and properties for one torrent', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=sid; Path=/' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ hash: 'h1', name: 'Ubuntu', state: 'uploading', total_size: 1000 }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ comment: 'official', piece_size: 16384 }), { status: 200 }));
    const client = new QbitClient({ baseUrl: 'http://localhost:8080', username: 'u', password: 'p' }, fetchMock as typeof fetch);

    const result = await client.get('h1');
    expect(result).toMatchObject({ hash: 'h1', state: 'completed', piece_size_bytes: 16384 });
    expect(result).not.toHaveProperty('comment');
  });
});
