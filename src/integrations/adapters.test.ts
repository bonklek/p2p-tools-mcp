import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createIntegrationRegistry } from './registry.js';
import { loadConfigFromString } from '../shared/config.js';

const config = loadConfigFromString('network_guard:\n  enabled: false');
const hash = 'a'.repeat(40);
const searchId = '01234567-89ab-4def-8123-456789abcdef';
const batchId = '11234567-89ab-4def-8123-456789abcdef';
const cid = 'Qm' + 'a'.repeat(44);
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const build = (service: string, fetcher: typeof fetch, overrides = {}) => createIntegrationRegistry({ ...config, integrations: { [service]: { enabled: true, ...(service === 'transmission' ? {} : { apiKey: 'fixture' }), ...overrides } } }, async () => ({ connected: false }), fetcher);

describe('Transmission protocol fixtures', () => {
  it.each([false, true])('negotiates once per rejected request and uses the correct dialect; modern=%s', async (modern) => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (!(init?.headers as Record<string, string>)['X-Transmission-Session-Id']) return new Response(null, { status: 409, headers: { 'X-Transmission-Session-Id': 'fixture-session' } });
      bodies.push(body);
      if (body.method === 'session-get') return json({ result: 'success', arguments: { version: modern ? '4.1.0' : '4.0.6', 'rpc-version-semver': modern ? '6.0.0' : undefined } });
      return modern ? json({ jsonrpc: '2.0', id: 1, result: {} }) : json({ result: 'success', arguments: {} });
    }) as typeof fetch;
    const registry = build('transmission', fetcher);
    expect(await registry.handlers.transmission_delete({ hashes: [hash] })).toMatchObject({ ok: true });
    expect(bodies[1]).toEqual(modern ? { jsonrpc: '2.0', method: 'torrent_remove', params: { ids: [hash], delete_local_data: false }, id: 1 } : { method: 'torrent-remove', arguments: { ids: [hash], 'delete-local-data': false }, tag: 1 });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('rejects RPC errors despite HTTP success, without retrying the mutation', async () => {
    const fetcher = vi.fn(async (_url, init) => JSON.parse(String(init?.body)).method === 'session-get'
      ? json({ result: 'success', arguments: { version: '4.0.6' } }) : json({ result: 'canary failure', arguments: {} }));
    const result = await build('transmission', fetcher).handlers.transmission_pause({ hashes: [hash] });
    expect(result).toMatchObject({ ok: false, error: { code: 'INTEGRATION_REQUEST_FAILED' } });
    expect(fetcher).toHaveBeenCalledTimes(2); expect(JSON.stringify(result)).not.toContain('canary');
  });

  it('accepts a duplicate add acknowledgment and preserves the paused default', async () => {
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === 'session-get') return json({ result: 'success', arguments: { version: '3.0.0' } });
      expect(body.arguments.paused).toBe(true);
      return json({ result: 'success', arguments: { 'torrent-duplicate': { hashString: hash } } });
    });
    expect(await build('transmission', fetcher).handlers.transmission_add({ source: `magnet:?xt=urn:btih:${hash}` })).toMatchObject({ ok: true, data: { duplicate: true, hash } });
  });

  it.each(['name', 'hashString', 'status', 'percentDone', 'totalSize', 'rateDownload', 'rateUpload'])('rejects nested payloads in normalized %s', async (field) => {
    const item = { name: 'Fixture', hashString: hash, status: 0, percentDone: 0, totalSize: 1, rateDownload: 0, rateUpload: 0, [field]: { opaque: 'canary' } };
    const fetcher = vi.fn(async (_url, init) => JSON.parse(String(init?.body)).method === 'session-get' ? json({ result: 'success', arguments: { version: '4.0.6' } }) : json({ result: 'success', arguments: { torrents: [item] } }));
    const result = await build('transmission', fetcher).handlers.transmission_list({});
    expect(result).toMatchObject({ ok: false, error: { code: 'INTEGRATION_INVALID_RESPONSE' } }); expect(JSON.stringify(result)).not.toContain('canary');
  });

  it('bounds failed 409 negotiation and supports an explicit RPC path', async () => {
    const fetcher = vi.fn(async (url) => { expect(String(url)).toContain('/custom/rpc'); return new Response(null, { status: 409, headers: { 'X-Transmission-Session-Id': 'fixture' } }); });
    expect(await build('transmission', fetcher, { rpcPath: '/custom/rpc' }).handlers.transmission_test({})).toMatchObject({ ok: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('Soulseek asynchronous and partial outcomes', () => {
  it('pages progress without exposing service paths or exception text',async()=>{
    const fetcher=vi.fn(async()=>json([{directories:[{files:[
      {id:'one',batchId,state:'Completed, Succeeded',filename:'private\\music\\Song [live].flac',size:12,bytesTransferred:12,exception:'do-not-return'},
      {id:'two',batchId,state:'Queued',filename:'private\\music\\Other.flac',size:24,bytesTransferred:0}
    ]}]}]));
    const result=await build('slskd',fetcher).handlers.slskd_transfers({limit:1,offset:0});
    expect(result).toMatchObject({ok:true,data:{total:2,truncated:true,transfers:[{id:'one',title:'Song [live].flac',size:12}]}});
    expect(JSON.stringify(result)).not.toMatch(/private|do-not-return/);
  });
  it('rejects a nonboolean account-login state',async()=>{
    expect(await build('slskd',vi.fn(async()=>json({isLoggedIn:'false'}))).handlers.slskd_server({})).toMatchObject({ok:false,error:{code:'INTEGRATION_INVALID_RESPONSE'}});
  });
  const files = [{ filename: 'private\\folder\\one.flac', size: 12 }, { filename: 'private\\folder\\two.flac', size: 24 }];
  const ids = files.map((file) => createHash('sha256').update(JSON.stringify(['fixture-user', file.filename, file.size])).digest('hex'));
  it('returns pending searches and preserves a safe reconciliation ID on timeout', async () => {
    const fetcher = vi.fn(async (_url, init) => json({ id: JSON.parse(String(init?.body)).id, state: 'InProgress', isComplete: false }));
    expect(await build('slskd', fetcher).handlers.slskd_search({ query: 'fixture', search_id: searchId.toUpperCase() })).toMatchObject({ ok: true, data: { outcome: 'pending', search_id: searchId } });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ searchText: 'fixture', searchTimeout: 15000 });
    const slow = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(Error('canary')))));
    const result = await build('slskd', slow, { timeoutMs: 10 }).handlers.slskd_search({ query: 'fixture' });
    expect(result).toMatchObject({ ok: false, error: { code: 'INTEGRATION_TIMEOUT', request_id: expect.stringMatching(/^[a-f0-9-]{36}$/) } });
  });

  it('returns stable selection IDs without exposing remote paths', async () => {
    const fetcher = vi.fn(async (url) => String(url).endsWith('/responses') ? json([{ username: 'fixture-user', files }]) : json({ isComplete: true }));
    const result = await build('slskd', fetcher).handlers.slskd_results({ search_id: searchId });
    expect(result).toMatchObject({ ok: true, data: { files: [{ file_id: ids[0], title: 'one.flac' }, { file_id: ids[1] }] } });
    expect(JSON.stringify(result)).not.toMatch(/private|filename/);
  });

  it('distinguishes an expired search or batch from a temporary service failure', async () => {
    const missing = vi.fn(async () => new Response(null, { status: 404 }));
    const registry = build('slskd', missing);
    expect(await registry.handlers.slskd_results({ search_id: searchId })).toMatchObject({ ok: false, error: { code: 'INTEGRATION_NOT_FOUND' } });
    expect(await registry.handlers.slskd_batch({ batch_id: batchId })).toMatchObject({ ok: false, error: { code: 'INTEGRATION_NOT_FOUND' } });
  });

  it('filters full slskd metadata locally and keeps paths out of results', async () => {
    const rich = [
      { filename: 'private\\Cello Album\\Bach.flac', size: 34_000_000, bitRate: 900, length: 240, bitDepth: 24, sampleRate: 96000, isVariableBitRate: false },
      { filename: 'private\\Cello Album\\cover.jpg', size: 1000 }
    ];
    const fetcher = vi.fn(async (url) => String(url).endsWith('/responses')
      ? json([{ username: 'fixture-user', hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 50000, files: rich, lockedFiles: [{ filename: 'private\\Cello Album\\locked.flac', size: 12 }] }])
      : json({ isComplete: true, searchText: 'Bach Cello Suite' }));
    const result = await build('slskd', fetcher).handlers.slskd_results({ search_id: searchId, filters: { file_types: ['audio'], public_only: true, lossless_only: true, min_bit_depth: 24, min_files_in_folder: 3 } });
    expect(result).toMatchObject({ ok: true, data: { search_query: 'Bach Cello Suite', total_matches: 1, files: [{ title: 'Bach.flac', extension: 'flac', bitrate_kbps: 900, bit_depth: 24, folder_result_count: 3, free_upload_slot: true }] } });
    expect(JSON.stringify(result)).not.toContain('private\\');
  });

  it('does not enqueue a locked Soulseek file', async () => {
    const locked = { filename: 'private\\locked.flac', size: 12 };
    const id = createHash('sha256').update(JSON.stringify(['fixture-user', locked.filename, locked.size])).digest('hex');
    const fetcher = vi.fn(async () => json([{ username: 'fixture-user', files: [], lockedFiles: [locked] }]));
    expect(await build('slskd', fetcher).handlers.slskd_download({ search_id: searchId, username: 'fixture-user', file_ids: [id] })).toMatchObject({ ok: false, error: { code: 'INTEGRATION_SELECTION_EXPIRED' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([200, 201, 207])('interprets batch status %s and identifies failed selections', async (status) => {
    const failures = status === 201 ? [] : status === 207 ? [{ filename: files[0].filename, message: 'canary' }] : files.map(({ filename }) => ({ filename, message: 'canary' }));
    const fetcher = vi.fn(async (url, init) => {
      if (String(url).endsWith('/responses')) return json([{ username: 'fixture-user', files }]);
      expect(JSON.parse(String(init?.body)).files).toEqual(files);
      return json({ batch: { id: batchId }, failures }, status);
    });
    const result = await build('slskd', fetcher).handlers.slskd_download({ search_id: searchId, username: 'fixture-user', file_ids: ids, batch_id: batchId });
    expect(result).toMatchObject({ ok: true, data: { outcome: status === 201 ? 'accepted' : status === 207 ? 'partial' : 'failed', failed_file_ids: status === 201 ? [] : status === 207 ? [ids[0]] : ids } });
    expect(JSON.stringify(result)).not.toMatch(/canary|private/);
  });

  it('rejects same-name selections before enqueueing an ambiguous batch', async () => {
    const duplicates = [{ filename: files[0].filename, size: 12 }, { filename: files[0].filename, size: 24 }];
    const duplicateIds = duplicates.map((file) => createHash('sha256').update(JSON.stringify(['fixture-user', file.filename, file.size])).digest('hex'));
    const fetcher = vi.fn(async () => json([{ username: 'fixture-user', files: duplicates }]));
    const result = await build('slskd', fetcher).handlers.slskd_download({ search_id: searchId, username: 'fixture-user', file_ids: duplicateIds });
    expect(result).toMatchObject({ ok: false, error: { code: 'INTEGRATION_SELECTION_EXPIRED' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([{ failures: [] }, { batch: { id: 'wrong' }, failures: [] }, { batch: { id: batchId }, failures: [{ filename: 'unknown' }] }])('rejects malformed batch acknowledgments %#', async (response) => {
    const fetcher = vi.fn(async (url) => String(url).endsWith('/responses') ? json([{ username: 'fixture-user', files }]) : json(response, response.failures.length ? 207 : 201));
    expect(await build('slskd', fetcher).handlers.slskd_download({ search_id: searchId, username: 'fixture-user', file_ids: ids, batch_id: batchId })).toMatchObject({ ok: false, error: { code: 'INTEGRATION_INVALID_RESPONSE', request_id: batchId } });
  });

  it('reports progress from upstream transfer entries and omits exceptions and filenames', async () => {
    const fetcher = vi.fn(async () => json({ id: batchId, transfers: [{ id: searchId, state: 'Completed', bytesTransferred: 12, size: 12, percentComplete: 100, filename: 'canary', exception: 'canary' }] }));
    const result = await build('slskd', fetcher).handlers.slskd_batch({ batch_id: batchId });
    expect(result).toMatchObject({ ok: true, data: { transfers: [{ state: 'Completed', bytesTransferred: 12 }] } });
    expect(JSON.stringify(result)).not.toContain('canary');
  });
});

describe('inspection and cross-seed adapters', () => {
  it('accepts an empty Kubo pin store while rejecting malformed populated responses', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({ unexpected: 'canary' }));
    const registry = build('ipfs', fetcher);
    expect(await registry.handlers.ipfs_pin_list({})).toEqual({ ok: true, data: { pins: [], truncated: false } });
    expect(await registry.handlers.ipfs_pin_list({})).toMatchObject({ ok: false, error: { code: 'INTEGRATION_INVALID_RESPONSE' } });
  });
  it('normalizes Prowlarr indexers and capability XML without configuration credentials', async () => {
    const registry = build('prowlarr', vi.fn(async (url) => String(url).includes('newznab')
      ? new Response('<caps><searching><search available="yes"/><tv-search available="yes"/></searching></caps>')
      : json([{ id: 1, name: 'Fixture', enable: true, fields: [{ value: 'canary' }] }])));
    const indexers = await registry.handlers.prowlarr_indexers({});
    expect(JSON.stringify(indexers)).not.toContain('canary');
    expect(await registry.handlers.prowlarr_caps({ indexer_id: 1 })).toMatchObject({ ok: true, data: { searching: { tvsearch: true } } });
  });
  it('distinguishes cross-seed unauthenticated ping from accepted matching work', async () => {
    const fetcher = vi.fn(async (url, init) => {
      if (String(url).endsWith('/api/ping')) return new Response('pong');
      expect((init?.headers as Record<string, string>)['X-API-Key']).toBe('fixture');
      expect(JSON.parse(String(init?.body))).toEqual({ infoHash: hash });
      return new Response(null, { status: 204 });
    });
    const registry = build('cross_seed', fetcher);
    expect(await registry.handlers.cross_seed_test({})).toMatchObject({ ok: true, data: { credentials_verified: false } });
    expect(await registry.handlers.cross_seed_match({ hash })).toMatchObject({ ok: true, data: { outcome: 'pending', dependencies_verified: false } });
  });

  it('does not equate Gluetun running with verified isolation and rejects non-IP data', async () => {
    const registry = build('gluetun', vi.fn(async (url) => String(url).endsWith('/status') ? json({ status: 'running', credentials: 'canary' }) : json({ public_ip: 'canary' })));
    expect(await registry.handlers.gluetun_test({})).toEqual({ ok: true, data: { status: 'running', traffic_isolation_verified: false } });
    expect(await registry.handlers.gluetun_public_ip({})).toMatchObject({ ok: false });
  });

  it('bounds Syncthing output and omits addresses and folder error details', async () => {
    const registry = build('syncthing', vi.fn(async (url) => {
      if (String(url).includes('connections')) return json({ connections: { fixture: { connected: true, address: 'canary', extra: 'canary' } } });
      expect(String(url)).toContain('perpage=25');
      return json({ errors: [{ path: 'canary', error: 'canary' }] });
    }));
    const connections = await registry.handlers.syncthing_connections({});
    expect(connections).toMatchObject({ ok: true, data: { devices: [{ device_id: 'fixture', connected: true }] } });
    const errors = await registry.handlers.syncthing_folder_errors({ folder: 'fixture' });
    expect(errors).toMatchObject({ ok: true, data: { count: 1 } });
    expect(JSON.stringify([connections, errors])).not.toContain('canary');
  });

  it('uses Kubo POST query operations, bounds previews, and validates pin acknowledgments', async () => {
    const fetcher = vi.fn(async (url, init) => {
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer fixture');
      if (String(url).includes('/cat')) { expect(String(url)).toContain('length=5'); return new Response('hello'); }
      if (String(url).includes('/pin/ls')) return json({ Keys: { [cid]: { Type: 'recursive', Name: 'canary' } } });
      return json({ Pins: [cid] });
    });
    const registry = build('ipfs', fetcher);
    expect(await registry.handlers.ipfs_read({ cid, max_bytes: 4 })).toMatchObject({ ok: true, data: { text: 'hell', truncated: true } });
    const pins = await registry.handlers.ipfs_pin_list({});
    expect(pins).toMatchObject({ ok: true, data: { pins: [{ cid, Type: 'recursive' }] } }); expect(JSON.stringify(pins)).not.toContain('canary');
    expect(await registry.handlers.ipfs_pin_add({ cid })).toMatchObject({ ok: true, data: { pinned: true } });
    expect(await registry.handlers.ipfs_pin_remove({ cid })).toMatchObject({ ok: true, data: { pinned: false } });
    expect(await registry.handlers.ipfs_pin_add({ cid: '../canary' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  });
});
