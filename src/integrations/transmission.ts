import { z } from 'zod';
import { McpError } from '../shared/errors.js';
import { torrentHash, torrentSource } from '../torrent/validation.js';
import { record, array, pick } from './http.js';
import type { AdapterContext, IntegrationOperation } from './types.js';

/** Negotiate with read-only calls, never retry a mutation in a different dialect. */
async function rpc(ctx: AdapterContext, method: string, params: Record<string, unknown>, modern = false) {
  let sessionId: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers: Record<string, string> = {};
    if (ctx.config.username) headers.Authorization = `Basic ${Buffer.from(`${ctx.config.username}:${ctx.config.password}`).toString('base64')}`;
    if (sessionId) headers['X-Transmission-Session-Id'] = sessionId;
    const result = await ctx.http.request(ctx.config.rpcPath ?? '/transmission/rpc', ctx.signal, { method: 'POST', headers, allow409: true,
      body: modern ? { jsonrpc: '2.0', method, params, id: 1 } : { method, arguments: params, tag: 1 } });
    if (result.status === 409) {
      if (!result.sessionId || attempt) throw new McpError('INTEGRATION_REQUEST_FAILED', 'RPC negotiation failed');
      sessionId = result.sessionId; continue;
    }
    const envelope = record(result.data);
    if (modern) {
      if (envelope.error || envelope.jsonrpc !== '2.0' || envelope.id !== 1) throw new McpError('INTEGRATION_REQUEST_FAILED', 'RPC operation failed');
      return record(envelope.result);
    }
    if (envelope.result !== 'success') throw new McpError('INTEGRATION_REQUEST_FAILED', 'RPC operation failed');
    return record(envelope.arguments);
  }
  throw new McpError('INTEGRATION_REQUEST_FAILED', 'RPC negotiation failed');
}
async function dialect(ctx: AdapterContext) {
  const session = await rpc(ctx, 'session-get', {});
  if (typeof session.version !== 'string' || !/^[34]\./.test(session.version)) throw new McpError('INTEGRATION_UNSUPPORTED_VERSION', 'Unsupported Transmission family');
  return { session, modern: Number(String(session['rpc-version-semver'] ?? '').split('.')[0]) >= 6 };
}
const hashes = z.array(torrentHash).min(1).max(100);
export const transmissionOperations: IntegrationOperation[] = [
  { service: 'transmission', action: 'test', description: 'Check Transmission 3.x or 4.x RPC access and negotiated dialect.', schema: {}, run: async (ctx) => {
    const result = await dialect(ctx);
    return { ...pick(result.session, ['version']), rpc_format: result.modern ? 'jsonrpc2' : 'legacy' };
  } },
  { service: 'transmission', action: 'list', description: 'List bounded torrent metadata.', schema: { hashes: hashes.optional(), limit: z.number().int().min(1).max(100).default(25) }, run: async (ctx, input) => {
    const { modern } = await dialect(ctx);
    const fields = modern ? ['name', 'hash_string', 'status', 'percent_done', 'total_size', 'rate_download', 'rate_upload'] : ['name', 'hashString', 'status', 'percentDone', 'totalSize', 'rateDownload', 'rateUpload'];
    const result = await rpc(ctx, modern ? 'torrent_get' : 'torrent-get', { fields, ...(input.hashes ? { ids: input.hashes } : {}) }, modern);
    const torrents = array(result.torrents);
    return { torrents: torrents.slice(0, Number(input.limit)).map((value) => {
      const item = record(value);
      if (typeof item.name !== 'string' || !torrentHash.safeParse(item[fields[1]]).success || fields.slice(2).some((field) => typeof item[field] !== 'number' || !Number.isFinite(item[field]))) throw new McpError('INTEGRATION_INVALID_RESPONSE', 'Malformed torrent metadata');
      return { name: item.name, hash: item[fields[1]], status: item.status, progress: item[fields[3]], size: item[fields[4]], download_speed: item[fields[5]], upload_speed: item[fields[6]] };
    }), truncated: torrents.length > Number(input.limit) };
  } },
  { service: 'transmission', action: 'add', description: 'Add a magnet or HTTP(S) torrent source, paused by default.', schema: { source: torrentSource, paused: z.boolean().default(true) }, mutation: true, guard: 'torrent_add', run: async (ctx, input) => {
    const { modern } = await dialect(ctx);
    const result = await rpc(ctx, modern ? 'torrent_add' : 'torrent-add', { filename: input.source, paused: input.paused }, modern);
    const duplicate = result[modern ? 'torrent_duplicate' : 'torrent-duplicate'];
    const added = record(duplicate ?? result[modern ? 'torrent_added' : 'torrent-added']);
    const hash = added[modern ? 'hash_string' : 'hashString'];
    if (!torrentHash.safeParse(hash).success) throw new McpError('INTEGRATION_INVALID_RESPONSE', 'Missing accepted torrent hash');
    return { accepted: true, duplicate: !!duplicate, hash, next_action: 'List torrents to verify the actual state.' };
  } },
  ...(['pause', 'resume', 'delete'] as const).map((action): IntegrationOperation => ({ service: 'transmission', action,
    description: `${action} explicit torrent hashes${action === 'delete' ? '; retain files by default' : ''}.`,
    schema: { hashes, ...(action === 'delete' ? { delete_files: z.boolean().default(false) } : {}) }, mutation: true, destructive: action === 'delete', guard: action === 'pause' ? 'torrent_pause' : action === 'resume' ? 'torrent_resume' : 'torrent_delete',
    run: async (ctx, input) => {
      const { modern } = await dialect(ctx);
      const verb = action === 'pause' ? 'stop' : action === 'resume' ? 'start' : 'remove';
      await rpc(ctx, `torrent${modern ? '_' : '-'}${verb}`, { ids: input.hashes,
        ...(action === 'delete' ? { [modern ? 'delete_local_data' : 'delete-local-data']: input.delete_files } : {}) }, modern);
      return { accepted: true };
    }
  }))
];
