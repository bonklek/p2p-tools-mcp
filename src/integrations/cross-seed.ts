import { McpError } from '../shared/errors.js';
import { torrentHash } from '../torrent/validation.js';
import { keyed } from './inspection.js';
import type { IntegrationOperation } from './types.js';

export const crossSeedOperations: IntegrationOperation[] = [
  { service: 'cross_seed', action: 'test', description: 'Check cross-seed reachability; ping does not validate credentials or its dependencies.', schema: {}, run: async (ctx) => {
    await ctx.http.request('/api/ping', ctx.signal, { text: true });
    return { reachable: true, credentials_verified: false, dependencies_verified: false };
  } },
  { service: 'cross_seed', action: 'match', description: 'Request cross-seeding for one torrent; acceptance does not mean matches or injection succeeded.', schema: { hash: torrentHash }, mutation: true, guard: 'torrent_add', run: async (ctx, input) => {
    const response = await ctx.http.request('/api/webhook', ctx.signal, { method: 'POST', headers: keyed(ctx), body: { infoHash: input.hash }, text: true });
    if (response.status !== 204) throw new McpError('INTEGRATION_INVALID_RESPONSE', 'Unexpected webhook acknowledgment');
    return { accepted: true, outcome: 'pending', dependencies_verified: false, next_action: 'Inspect cross-seed logs and the configured torrent client for the matching outcome.' };
  } }
];
