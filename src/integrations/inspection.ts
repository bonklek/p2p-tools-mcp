import { z } from 'zod';
import { isIP } from 'node:net';
import { McpError } from '../shared/errors.js';
import { record, array, pick } from './http.js';
import type { AdapterContext, IntegrationOperation } from './types.js';

export const cid = z.string().regex(/^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120})$/).describe('Use a CIDv0 base58 or CIDv1 lowercase base32 content identifier.');
const id = z.string().min(1).max(256);
const limit = z.number().int().min(1).max(100).default(25);
const query = (input: Record<string, unknown>) => new URLSearchParams(Object.entries(input).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
export const keyed = (context: AdapterContext) => ({ 'X-API-Key': context.config.apiKey! });
async function get(context: AdapterContext, path: string, params?: Record<string, unknown>) {
  return (await context.http.request(path, context.signal, { headers: keyed(context), query: params ? query(params) : undefined })).data;
}
async function kubo(context: AdapterContext, action: string, params: Record<string, unknown> = {}, text = false) {
  return (await context.http.request(`/api/v0/${action}`, context.signal, { method: 'POST', query: query(params), text,
    headers: context.config.apiKey ? { Authorization: `Bearer ${context.config.apiKey}` } : {} })).data;
}

export const inspectionOperations: IntegrationOperation[] = [
  { service: 'gluetun', action: 'test', description: 'Read Gluetun operational status; does not verify traffic isolation.', schema: {}, run: async (ctx) => {
    const value = record(await get(ctx, '/v1/vpn/status'));
    if (typeof value.status !== 'string') throw new McpError('INTEGRATION_INVALID_RESPONSE', 'Missing status');
    return { status: value.status, traffic_isolation_verified: false };
  } },
  { service: 'gluetun', action: 'public_ip', description: 'Read the public IP reported by Gluetun.', schema: {}, run: async (ctx) => {
    const value = record(await get(ctx, '/v1/publicip/ip'));
    if (typeof value.public_ip !== 'string' || !isIP(value.public_ip)) throw new McpError('INTEGRATION_INVALID_RESPONSE', 'Public IP unavailable');
    return { public_ip: value.public_ip, traffic_isolation_verified: false };
  } },
  { service: 'syncthing', action: 'test', description: 'Check Syncthing API access.', schema: {}, run: async (ctx) => {
    const value = record(await get(ctx, '/rest/system/ping'));
    if (value.ping !== 'pong') throw new McpError('INTEGRATION_INVALID_RESPONSE', 'Invalid ping');
    return { reachable: true };
  } },
  { service: 'syncthing', action: 'connections', description: 'Inspect device connectivity without exposing addresses.', schema: { limit }, run: async (ctx, input) => {
    const connections = Object.entries(record(record(await get(ctx, '/rest/system/connections')).connections));
    return { devices: connections.slice(0, Number(input.limit)).map(([device_id, value]) => ({ device_id, ...pick(value, ['connected', 'paused', 'type', 'inBytesTotal', 'outBytesTotal']) })), truncated: connections.length > Number(input.limit) };
  } },
  { service: 'syncthing', action: 'completion', description: 'Read synchronization completion for a folder or aggregate.', schema: { folder: id.optional(), device: id.optional() }, run: async (ctx, input) =>
    pick(await get(ctx, '/rest/db/completion', input), ['completion', 'globalBytes', 'needBytes', 'needItems', 'needDeletes']) },
  { service: 'syncthing', action: 'folder_status', description: 'Read folder state; this service operation can be expensive.', schema: { folder: id }, run: async (ctx, input) =>
    pick(await get(ctx, '/rest/db/status', input), ['state', 'stateChanged', 'globalBytes', 'localBytes', 'needBytes', 'needTotalItems', 'pullErrors']) },
  { service: 'syncthing', action: 'folder_errors', description: 'Count a bounded page of folder errors without exposing local filenames or raw errors.', schema: { folder: id, page: z.number().int().min(1).max(10000).default(1), limit }, run: async (ctx, input) => {
    const value = record(await get(ctx, '/rest/folder/errors', { folder: input.folder, page: input.page, perpage: input.limit }));
    const errors = array(value.errors);
    return { page: input.page, count: errors.length, may_have_more: errors.length === input.limit, next_action: errors.length ? 'Inspect folder error details in the Syncthing UI.' : 'No errors on this page.' };
  } },
  { service: 'ipfs', action: 'test', description: 'Read the local Kubo node identity and version.', schema: {}, run: async (ctx) => {
    const value = record(await kubo(ctx, 'id'));
    if (typeof value.ID !== 'string') throw new McpError('INTEGRATION_INVALID_RESPONSE', 'Missing node identity');
    return pick(value, ['ID', 'AgentVersion']);
  } },
  { service: 'ipfs', action: 'read', description: 'Retrieve a bounded UTF-8 file preview by CID; may fetch blocks from peers.', schema: { cid, max_bytes: z.number().int().min(1).max(65536).default(4096) }, guard: 'torrent_search', run: async (ctx, input) => {
    const value = String(await kubo(ctx, 'cat', { arg: input.cid, length: Number(input.max_bytes) + 1 }, true));
    const bytes = Buffer.from(value);
    return { text: bytes.subarray(0, Number(input.max_bytes)).toString('utf8'), truncated: bytes.length > Number(input.max_bytes), format: 'utf8_preview' };
  } },
  { service: 'ipfs', action: 'pin_list', description: 'List a bounded set of locally retained CIDs.', schema: { cid: cid.optional(), limit }, run: async (ctx, input) => {
    const response = record(await kubo(ctx, 'pin/ls', { arg: input.cid, type: 'all', stream: false }));
    const keys = Object.entries(record(Object.keys(response).length === 0 ? {} : response.Keys));
    return { pins: keys.slice(0, Number(input.limit)).map(([cid, value]) => ({ cid, ...pick(value, ['Type']) })), truncated: keys.length > Number(input.limit) };
  } },
  ...(['pin_add', 'pin_remove'] as const).map((action): IntegrationOperation => ({ service: 'ipfs', action,
    description: action === 'pin_add' ? 'Retain a CID recursively; may download missing blocks.' : 'Remove recursive pin retention; does not immediately delete content.',
    schema: { cid }, mutation: true, destructive: action === 'pin_remove', guard: action === 'pin_add' ? 'torrent_add' : undefined,
    run: async (ctx, input) => {
      const value = record(await kubo(ctx, action === 'pin_add' ? 'pin/add' : 'pin/rm', { arg: input.cid, recursive: true, progress: false }));
      const pins = array(value.Pins);
      if (!pins.includes(input.cid)) throw new McpError('INTEGRATION_INVALID_RESPONSE', 'Requested pin state not acknowledged');
      return { cid: input.cid, pinned: action === 'pin_add' };
    }
  }))
];
