import { z } from 'zod';
import { McpError } from '../shared/errors.js';
import { array, record, pick } from './http.js';
import { keyed } from './inspection.js';
import type { AdapterContext, IntegrationOperation } from './types.js';
import { normalizeJackettCaps } from '../torrent/jackett-normalize.js';

async function get(ctx: AdapterContext, path: string, query?: URLSearchParams) {
  return (await ctx.http.request(`/api/v1/${path}`, ctx.signal, { headers: keyed(ctx), query })).data;
}
export const prowlarrOperations: IntegrationOperation[] = [
  { service: 'prowlarr', action: 'caps', description: 'Read capabilities of a configured Prowlarr indexer.', schema: { indexer_id: z.number().int().positive() }, run: async (ctx, input) => {
    const result = await ctx.http.request(`/api/v1/indexer/${input.indexer_id}/newznab`, ctx.signal, { headers: keyed(ctx), query: new URLSearchParams({ t: 'caps' }), text: true });
    return normalizeJackettCaps(String(result.data), String(input.indexer_id));
  } },
  { service: 'prowlarr', action: 'test', description: 'Check Prowlarr API access and version.', schema: {}, run: async (ctx) => {
    const value = record(await get(ctx, 'system/status'));
    if (typeof value.version !== 'string') throw new McpError('INTEGRATION_INVALID_RESPONSE', 'Version missing');
    return pick(value, ['version']);
  } },
  { service: 'prowlarr', action: 'indexers', description: 'List indexers without configuration fields or credentials.', schema: { limit: z.number().int().min(1).max(100).default(25) }, run: async (ctx, input) => {
    const items = array(await get(ctx, 'indexer'));
    return { indexers: items.slice(0, Number(input.limit)).map((item) => pick(item, ['id', 'name', 'enable', 'protocol', 'privacy'])), truncated: items.length > Number(input.limit) };
  } },
  { service: 'prowlarr', action: 'search', description: 'Search Prowlarr and return metadata without sensitive acquisition URLs.', schema: {
    query: z.string().min(1).max(512), indexer_ids: z.array(z.number().int().positive()).min(1).max(25).optional(),
    limit: z.number().int().min(1).max(100).default(25), offset: z.number().int().min(0).max(10000).default(0)
  }, guard: 'torrent_search', run: async (ctx, input) => {
    const params = new URLSearchParams({ query: String(input.query), type: 'search', limit: String(input.limit), offset: String(input.offset) });
    for (const id of (input.indexer_ids ?? []) as number[]) params.append('indexerIds', String(id));
    const results = array(await get(ctx, 'search', params));
    return { results: results.slice(0, Number(input.limit)).map((item) => pick(item, ['title', 'indexerId', 'indexer', 'size', 'seeders', 'leechers', 'publishDate', 'infoHash'])), returned: Math.min(results.length, Number(input.limit)), truncated: results.length > Number(input.limit), offset: input.offset };
  } }
];
