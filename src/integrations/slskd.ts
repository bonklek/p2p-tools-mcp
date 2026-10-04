import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { McpError } from '../shared/errors.js';
import { array, record, pick } from './http.js';
import { keyed } from './inspection.js';
import { displaySlskdFile, filterSlskdFiles, folderOf, slskdFiltersSchema, validateSlskdFilters, type SlskdFile } from './slskd-filters.js';
import type { AdapterContext, IntegrationOperation } from './types.js';

async function request(ctx: AdapterContext, path: string, body?: unknown) {
  return ctx.http.request(`/api/v0/${path}`, ctx.signal, { headers: keyed(ctx), ...(body === undefined ? {} : { method: 'POST', body }) });
}
const fileId = (username: string, filename: string, size: number) => createHash('sha256').update(JSON.stringify([username, filename, size])).digest('hex');
function optionalInteger(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new McpError('INTEGRATION_INVALID_RESPONSE', 'Invalid file metadata');
  return value;
}
function optionalBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new McpError('INTEGRATION_INVALID_RESPONSE', 'Invalid file metadata');
  return value;
}
async function files(ctx: AdapterContext, searchId: string) {
  const responses = array((await request(ctx, `searches/${encodeURIComponent(searchId)}/responses`)).data);
  const found: SlskdFile[] = responses.flatMap((value) => {
    const response = record(value);
    if (typeof response.username !== 'string' || !response.username) throw new McpError('INTEGRATION_INVALID_RESPONSE', 'Missing username');
    const username = response.username;
    const free_upload_slot = optionalBoolean(response, 'hasFreeUploadSlot');
    const queue_length = optionalInteger(response, 'queueLength');
    const upload_speed_bytes_per_second = optionalInteger(response, 'uploadSpeed');
    const parseFiles = (values: unknown[], locked: boolean) => values.map((value): SlskdFile => {
      const file = record(value);
      if (typeof file.filename !== 'string' || typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0) throw new McpError('INTEGRATION_INVALID_RESPONSE', 'Invalid file metadata');
      const filename = file.filename;
      const basename = filename.split(/[\\/]/).at(-1) ?? '';
      const extension = basename.includes('.') ? basename.split('.').at(-1)!.toLowerCase() : '';
      return {
        file_id: fileId(username, filename, file.size), username, filename, size: file.size,
        extension, is_locked: locked || optionalBoolean(file, 'isLocked') === true,
        bitrate_kbps: optionalInteger(file, 'bitRate'), duration_seconds: optionalInteger(file, 'length'),
        sample_rate_hz: optionalInteger(file, 'sampleRate'), bit_depth: optionalInteger(file, 'bitDepth'),
        vbr: optionalBoolean(file, 'isVariableBitRate'), free_upload_slot, queue_length, upload_speed_bytes_per_second
      };
    });
    return [...parseFiles(array(response.files), false), ...parseFiles(response.lockedFiles === undefined ? [] : array(response.lockedFiles), true)];
  });
  const counts = new Map<string, number>();
  for (const file of found) {
    const folder = folderOf(file.filename);
    const key = JSON.stringify([file.username, folder]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return found.map((file) => ({ ...file, folder_result_count: counts.get(JSON.stringify([file.username, folderOf(file.filename)])) ?? 0 }));
}
export const slskdOperations: IntegrationOperation[] = [
  { service: 'slskd', action: 'transfers', description: 'Inspect a bounded page of download progress for the music workflow. Titles are basenames; no local paths or service exceptions are returned.', schema: {
    limit: z.number().int().min(1).max(1000).default(1000), offset: z.number().int().min(0).default(0)
  }, run: async (ctx,input) => {
    const all = array((await request(ctx,'transfers/downloads')).data).flatMap(user => array(record(user).directories).flatMap(dir => array(record(dir).files).map(value => {
      const f = record(value);
      if (typeof f.id !== 'string' || typeof f.state !== 'string' || typeof f.filename !== 'string' || (f.batchId !== undefined && typeof f.batchId !== 'string')) throw new McpError('INTEGRATION_INVALID_RESPONSE','Invalid transfer metadata');
      return { id:f.id, batchId:f.batchId, state:f.state, size:optionalInteger(f,'size'), bytesTransferred:optionalInteger(f,'bytesTransferred'), placeInQueue:optionalInteger(f,'placeInQueue'), title:f.filename.split(/[\\/]/).at(-1) };
    })));
    return { transfers: all.slice(Number(input.offset),Number(input.offset)+Number(input.limit)), total:all.length, truncated:all.length>Number(input.offset)+Number(input.limit) };
  } },
  { service: 'slskd', action: 'server', description: 'Read Soulseek connection/login state separately from slskd API authentication.', schema: {}, run: async (ctx) => {
    const value=record((await request(ctx, 'server')).data);
    return {isConnected:optionalBoolean(value,'isConnected'),isLoggedIn:optionalBoolean(value,'isLoggedIn'),isTransitioning:optionalBoolean(value,'isTransitioning')};
  } },
  { service: 'slskd', action: 'test', description: 'Check slskd application API access; does not verify Soulseek connectivity.', schema: {}, run: async (ctx) => {
    const value = record((await request(ctx, 'application')).data);
    if (!Object.keys(value).length) throw new McpError('INTEGRATION_INVALID_RESPONSE', 'Empty application state');
    return { reachable: true, soulseek_connection_verified: false };
  } },
  { service: 'slskd', action: 'search', description: 'Start an asynchronous Soulseek search. Poll results with its search_id.', schema: {
    query: z.string().min(1).max(512), search_id: z.uuid().optional(), limit: z.number().int().min(1).max(100).default(25)
  }, mutation: true, guard: 'torrent_search', run: async (ctx, input) => {
    const searchId = String(input.search_id ?? randomUUID()).toLowerCase();
    const response = record((await request(ctx, 'searches', { id: searchId, searchText: input.query, fileLimit: input.limit, responseLimit: 25, searchTimeout: 15000 })).data);
    if (response.id !== searchId) throw new McpError('INTEGRATION_INVALID_RESPONSE', 'Search identifier not acknowledged');
    return { search_id: searchId, outcome: 'pending', ...pick(response, ['state', 'isComplete', 'fileCount', 'responseCount']) };
  } },
  { service: 'slskd', action: 'results', description: 'Read a search and bounded file selections. File IDs preserve exact selection without exposing remote paths.', schema: {
    search_id: z.uuid(), limit: z.number().int().min(1).max(100).default(25), filters: slskdFiltersSchema.optional()
  }, run: async (ctx, input) => {
    const filters = input.filters as z.infer<typeof slskdFiltersSchema> | undefined;
    validateSlskdFilters(filters);
    const search = await ctx.http.request(`/api/v0/searches/${input.search_id}`, ctx.signal, { headers: keyed(ctx), allow404: true });
    if (search.status === 404) throw new McpError('INTEGRATION_NOT_FOUND', 'Search was not found');
    const state = record(search.data);
    const all = await files(ctx, String(input.search_id));
    const matches = filterSlskdFiles(all, filters);
    return { search_id: input.search_id, ...pick(state, ['state', 'isComplete']), ...(typeof state.searchText === 'string' ? { search_query: state.searchText } : {}), files: matches.slice(0, Number(input.limit)).map(displaySlskdFile), total_matches: matches.length, truncated: matches.length > Number(input.limit) };
  } },
  { service: 'slskd', action: 'download', description: 'Enqueue selected search files from one user. Optional batch_id supports reconciliation after uncertain failures.', schema: {
    search_id: z.uuid(), username: z.string().min(1).max(256), file_ids: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(100), batch_id: z.uuid().optional()
  }, mutation: true, guard: 'torrent_add', run: async (ctx, input) => {
    const ids = [...new Set(input.file_ids as string[])];
    const matches = (await files(ctx, String(input.search_id))).filter((file) => !file.is_locked && file.username === input.username && ids.includes(file.file_id));
    const unique = [...new Map(matches.map((file) => [file.file_id, file])).values()];
    if (unique.length !== ids.length) throw new McpError('INTEGRATION_SELECTION_EXPIRED', 'Selected files are no longer available in this search');
    // slskd reports batch failures by filename only, so duplicate names cannot be reconciled safely.
    if (new Set(unique.map((file) => file.filename)).size !== unique.length) throw new McpError('INTEGRATION_SELECTION_EXPIRED', 'Selected filenames are ambiguous for batch reconciliation');
    const batchId = String(input.batch_id ?? randomUUID()).toLowerCase();
    const response = await request(ctx, 'transfers/downloads/batches', { id: batchId, searchId: input.search_id, username: input.username, files: unique.map(({ filename, size }) => ({ filename, size })) });
    const result = record(response.data);
    const failures = array(result.failures);
    if (record(result.batch).id !== batchId || ![200, 201, 207].includes(response.status)
      || (response.status === 201 && failures.length) || (response.status === 200 && failures.length !== unique.length)
      || (response.status === 207 && (!failures.length || failures.length >= unique.length))) throw new McpError('INTEGRATION_INVALID_RESPONSE', 'Invalid batch acknowledgment');
    const failedIds = failures.map((failure) => {
      const match = unique.find((file) => file.filename === record(failure).filename);
      if (!match) throw new McpError('INTEGRATION_INVALID_RESPONSE', 'Unknown failed file');
      return match.file_id;
    });
    if (new Set(failedIds).size !== failedIds.length) throw new McpError('INTEGRATION_INVALID_RESPONSE', 'Duplicate failed file');
    return { batch_id: batchId, outcome: response.status === 200 ? 'failed' : response.status === 207 ? 'partial' : 'accepted', failed_count: failures.length, failed_file_ids: failedIds, next_action: 'Inspect the batch to verify transfer progress; retry only the failed_file_ids.' };
  } },
  { service: 'slskd', action: 'batch', description: 'Inspect an existing download batch without exposing filenames or exceptions.', schema: { batch_id: z.uuid() }, run: async (ctx, input) => {
    const response = await ctx.http.request(`/api/v0/transfers/downloads/batches/${input.batch_id}`, ctx.signal, { headers: keyed(ctx), allow404: true });
    if (response.status === 404) throw new McpError('INTEGRATION_NOT_FOUND', 'Batch was not found');
    const result = record(response.data);
    const transfers = array(result.transfers);
    return { ...pick(result, ['id', 'username', 'createdAt']), transfers: transfers.slice(0, 100).map((transfer) => pick(transfer, ['id', 'state', 'size', 'bytesTransferred', 'percentComplete', 'placeInQueue'])), truncated: transfers.length > 100 };
  } }
];
