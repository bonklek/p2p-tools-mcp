import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppConfig } from '../shared/config.js';
import { McpError } from '../shared/errors.js';
import { invalidArgument, publicDiagnostic, schemaGuidance, validationError } from '../shared/diagnostics.js';
import { createDoctorReport } from '../doctor.js';
import { setupStatus } from '../setup.js';
import { musicHandlers, musicToolSpecs } from '../music/workflow.js';
import { createIntegrationRegistry } from '../integrations/registry.js';
import { JevRanker, type RankCandidate } from '../integrations/jev.js';
import { slskdFiltersSchema } from '../integrations/slskd-filters.js';
import { checkNetworkGuard, type VpnStatusProvider } from '../shared/network-guard.js';
import { mcpJsonContent, structuredResult, type ToolResult } from '../shared/tool-result.js';
import { PACKAGE_VERSION } from '../shared/version.js';
import { NordVpnClient } from '../vpn/nordvpn.js';
import { lookupCategory } from './categories.js';
import { JackettClient } from './jackett-client.js';
import { QbitClient } from './qbit-client.js';
import type { QbitAddOptions, QbitListOptions } from './qbit-types.js';
import { torrentHash, torrentHttpUrl, torrentMagnet, torrentSource } from './validation.js';

export interface TorrentDeps {
  jackett: Pick<JackettClient, 'search' | 'caps' | 'listIndexers' | 'testConnection'>;
  qbit: Pick<QbitClient, 'testConnection' | 'add' | 'list' | 'get' | 'pause' | 'resume' | 'delete'>;
  vpnStatusProvider: VpnStatusProvider;
}

type ToolHandler = (args: unknown) => Promise<ToolResult>;

export function createDefaultTorrentDeps(config: AppConfig): TorrentDeps {
  const vpnClient = new NordVpnClient({ command: config.vpn.command, timeoutMs: config.timeouts.commandMs, windowsStatusProvider: config.vpn.windowsStatusProvider });
  return {
    jackett: new JackettClient({ ...config.jackett, timeoutMs: config.timeouts.httpMs }),
    qbit: new QbitClient({ ...config.qbittorrent, timeoutMs: config.timeouts.httpMs }),
    vpnStatusProvider: () => vpnClient.status()
  };
}

export function createTorrentToolHandlers(config: AppConfig, deps: TorrentDeps, registry = createIntegrationRegistry(config, deps.vpnStatusProvider), ranker = config.jev ? new JevRanker(config.jev) : undefined): Record<string, ToolHandler> {
  const jackettSearch = (args: unknown) => structured(async () => {
    const input = objectArg(args);
    const searchType = optionalStringAt(input, 'search_type') ?? 'search';
    if (!['search', 'tvsearch', 'movie', 'music', 'book'].includes(searchType)) throw new McpError('INVALID_ARGUMENT', 'invalid search_type');
    if (searchType !== 'tvsearch' && (input.season !== undefined || input.episode !== undefined)) throw invalidArgument('search_type', 'Use tvsearch with season or episode.');
    if (searchType !== 'movie' && input.imdb_id !== undefined) throw invalidArgument('search_type', 'Use movie with imdb_id.');
    await requireNetworkGuard(config, deps.vpnStatusProvider, 'torrent_search');
    return deps.jackett.search({
      query: optionalStringAt(input, 'query'),
      indexer: optionalStringAt(input, 'indexer'),
      searchType: searchType as 'search' | 'tvsearch' | 'movie' | 'music' | 'book',
      categories: optionalNumberArrayAt(input, 'categories'),
      season: optionalNumberAt(input, 'season'),
      episode: optionalStringAt(input, 'episode'),
      imdbId: optionalStringAt(input, 'imdb_id'),
      limit: optionalNumberAt(input, 'limit') ?? 25,
      offset: optionalNumberAt(input, 'offset') ?? 0
    });
  });

  const jackettCaps = (args: unknown) => structured(async () => {
    await requireNetworkGuard(config, deps.vpnStatusProvider, 'torrent_caps');
    return deps.jackett.caps(optionalStringAt(objectArg(args), 'indexer'));
  });
  const jackettIndexers = () => structured(async () => {
    await requireNetworkGuard(config, deps.vpnStatusProvider, 'torrent_list_indexers');
    return deps.jackett.listIndexers();
  });
  const qbitAdd = (args: unknown) => structured(async () => {
    await requireNetworkGuard(config, deps.vpnStatusProvider, 'torrent_add');
    return deps.qbit.add(qbitAddOptions(args));
  });
  const qbitAddMagnet = (args: unknown) => structured(async () => {
    await requireNetworkGuard(config, deps.vpnStatusProvider, 'torrent_add');
    const input = objectArg(args);
    const magnet = stringAt(input, 'magnet_uri');
    if (!magnet.startsWith('magnet:')) throw new McpError('INVALID_ARGUMENT', 'magnet_uri must use the magnet scheme');
    return deps.qbit.add(qbitAddOptions(input));
  });
  const qbitAddUrl = (args: unknown) => structured(async () => {
    await requireNetworkGuard(config, deps.vpnStatusProvider, 'torrent_add');
    return deps.qbit.add(qbitAddOptions(args));
  });
  const qbitList = (args: unknown) => structured(async () => {
    await requireNetworkGuard(config, deps.vpnStatusProvider, 'torrent_list');
    return deps.qbit.list(qbitListOptions(args));
  });
  const qbitGet = (args: unknown) => structured(async () => {
    await requireNetworkGuard(config, deps.vpnStatusProvider, 'torrent_get');
    return deps.qbit.get(stringAt(objectArg(args), 'hash'));
  });
  const qbitPause = (args: unknown) => structured(async () => {
    await requireNetworkGuard(config, deps.vpnStatusProvider, 'torrent_pause');
    return deps.qbit.pause(hashesArg(args));
  });
  const qbitResume = (args: unknown) => structured(async () => {
    await requireNetworkGuard(config, deps.vpnStatusProvider, 'torrent_resume');
    return deps.qbit.resume(hashesArg(args));
  });
  const qbitDelete = (args: unknown) => structured(async () => {
    await requireNetworkGuard(config, deps.vpnStatusProvider, 'torrent_delete');
    const input = objectArg(args);
    if (input.delete_files !== undefined && input.deleteFiles !== undefined) throw new McpError('INVALID_ARGUMENT', 'Supply only one delete-files option');
    return deps.qbit.delete(hashesArg(args), Boolean(input.delete_files ?? input.deleteFiles));
  });

  const handlers: Record<string, ToolHandler> = {
    p2p_doctor: () => structured(async () => {
      const [report, integrations] = await Promise.all([createDoctorReport(config, deps), config.integrations === undefined ? Promise.resolve(undefined) : registry.diagnose()]);
      if (!integrations) return report;
      return { ...report, status: report.status === 'checks_passed' && integrations.some((item) => !['healthy', 'disabled'].includes(item.state)) ? 'attention_needed' : report.status, integrations };
    }),
    jackett_test_connection: () => structured(() => deps.jackett.testConnection()),
    jackett_search: jackettSearch,
    jackett_caps: jackettCaps,
    jackett_list_indexers: jackettIndexers,
    jackett_get_category: (args) => structured(async () => lookupCategory(stringAt(objectArg(args), 'query'))),
    qbittorrent_test_connection: () => structured(() => deps.qbit.testConnection()),
    qbittorrent_add_magnet: qbitAddMagnet,
    qbittorrent_add_torrent_url: qbitAddUrl,
    qbittorrent_list_torrents: qbitList,
    qbittorrent_get_torrent: qbitGet,
    qbittorrent_pause_torrent: qbitPause,
    qbittorrent_resume_torrent: qbitResume,
    qbittorrent_delete_torrent: qbitDelete,
    // Compatibility aliases retained for one migration release.
    torrent_search: jackettSearch,
    torrent_caps: jackettCaps,
    torrent_list_indexers: jackettIndexers,
    torrent_add: qbitAdd,
    torrent_list: qbitList,
    torrent_get: qbitGet,
    torrent_pause: qbitPause,
    torrent_resume: qbitResume,
    torrent_delete: qbitDelete
  };

  if (ranker) {
    handlers.jev_rank = (args) => structured(async () => {
      const input = objectArg(args);
      return ranker.rank(input.query as string, input.candidates as RankCandidate[], input.preferences as string[] | undefined);
    });
    if (registry.handlers.slskd_results) {
      handlers.slskd_rank = async (args) => {
        const input = objectArg(args);
        const found = await registry.handlers.slskd_results({ search_id: input.search_id, limit: input.limit, filters: input.filters });
        if (!found.ok) return found;
        return structured(async () => {
          const result = found.data as { search_query?: string; files: Array<Omit<RankCandidate, 'id' | 'size_bytes'> & { file_id: string; title: string; size: number; username: string }> };
          const files = result.files;
          if (!files.length) return { search_id: input.search_id, recommendation: null, ranked: [], note: 'No files were returned for this search.' };
          const query = input.query ?? result.search_query;
          if (typeof query !== 'string' || !query) throw new McpError('INVALID_ARGUMENT', 'Search query is unavailable; supply query explicitly');
          const preferredUsers = new Set((input.preferred_users as string[] | undefined)?.map((user) => user.toLowerCase()) ?? []);
          const ranked = await ranker.rank(query, files.map(({ file_id, username, title, size, ...metadata }) => ({
            id: file_id, title, size_bytes: size, ...metadata,
            ...(preferredUsers.size ? { preferred_source: preferredUsers.has(username.toLowerCase()) } : {})
          })), input.preferences as string[] | undefined);
          return { search_id: input.search_id, ...ranked, ranked: ranked.ranked.map((item) => ({ ...item, file_id: item.id, username: files.find((file) => file.file_id === item.id)?.username })) };
        });
      };
    }
  }

  const validated = Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, async (args: unknown): Promise<ToolResult> => {
    const parsed = z.strictObject(toolSpecs[name].inputSchema).safeParse(args ?? {});
    if (!parsed.success) return { ok: false, error: publicDiagnostic(validationError(parsed.error, schemaGuidance(toolSpecs[name].inputSchema)), 'Invalid tool argument') };
    return handler(parsed.data);
  }]));
  registry.setJackettSearch(validated.jackett_search);
  return { ...registry.handlers, ...validated, p2p_setup_status: () => structured(() => setupStatus(config, registry.handlers)), ...musicHandlers() };
}

const searchShape = {
  query: z.string().optional(),
  indexer: z.string().optional(),
  search_type: z.enum(['search', 'tvsearch', 'movie', 'music', 'book']).default('search'),
  categories: z.array(z.number().int()).optional(),
  season: z.number().int().positive().optional(),
  episode: z.string().optional(),
  imdb_id: z.string().regex(/^tt\d+$/).optional().describe('Use an IMDb identifier beginning with tt followed by digits.'),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0)
};
const addShape = {
  url: torrentSource.optional(), urls: z.array(torrentSource).min(1).optional(), magnet_uri: torrentMagnet.optional(), torrent_url: torrentHttpUrl.optional(),
  savepath: z.string().optional(), save_path: z.string().optional(), category: z.string().optional(), tags: z.array(z.string()).optional(),
  paused: z.boolean().optional(), skipChecking: z.boolean().optional(), skip_checking: z.boolean().optional()
};
const hashesShape = { hash: torrentHash.optional(), hashes: z.array(torrentHash).min(1).optional() };
const preferenceShape = z.array(z.string().trim().min(1).max(128)).max(15).optional();
const rankCandidateShape = z.strictObject({
  id: z.string().min(1).max(128), title: z.string().min(1).max(256), size_bytes: z.number().int().nonnegative().optional(),
  folder_name: z.string().max(128).optional(), extension: z.string().max(12).optional(),
  bitrate_kbps: z.number().int().nonnegative().optional(), duration_seconds: z.number().int().nonnegative().optional(),
  sample_rate_hz: z.number().int().nonnegative().optional(), bit_depth: z.number().int().nonnegative().optional(),
  vbr: z.boolean().optional(), is_public: z.boolean().optional(), free_upload_slot: z.boolean().optional(),
  queue_length: z.number().int().nonnegative().optional(), upload_speed_bytes_per_second: z.number().int().nonnegative().optional(),
  preferred_source: z.boolean().optional(), folder_result_count: z.number().int().nonnegative().optional()
});

const toolSpecs: Record<string, { description: string; inputSchema: z.ZodRawShape; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } }> = {
  ...musicToolSpecs,
  p2p_setup_status: { description: 'Read Soulseek API and account readiness. If user input is needed, notify the user using the returned message and local credential-entry command; never request passwords in chat.', inputSchema: {}, annotations: { readOnlyHint: true } },
  jev_rank: { description: 'Rank supplied music metadata and preferences with Jev; never downloads.', inputSchema: {
    query: z.string().min(1).max(512),
    candidates: z.array(rankCandidateShape).min(1).max(25), preferences: preferenceShape
  }, annotations: { readOnlyHint: true } },
  slskd_rank: { description: 'Filter a Soulseek search page and rank its metadata with Jev; never downloads.', inputSchema: {
    search_id: z.uuid(), query: z.string().min(1).max(512).optional(), limit: z.number().int().min(1).max(25).default(10),
    filters: slskdFiltersSchema.optional(), preferences: preferenceShape,
    preferred_users: z.array(z.string().trim().min(1).max(128)).max(20).optional()
  }, annotations: { readOnlyHint: true } },
  p2p_doctor: { description: 'Read-only setup diagnostics for service access and the host VPN guard. Does not verify traffic isolation.', inputSchema: {}, annotations: { readOnlyHint: true } },
  jackett_test_connection: { description: 'Validate Jackett connectivity and API-key access.', inputSchema: {}, annotations: { readOnlyHint: true } },
  jackett_search: { description: 'Search Jackett using typed Torznab modes and normalized results.', inputSchema: searchShape, annotations: { readOnlyHint: true } },
  jackett_caps: { description: 'Read normalized Torznab capabilities.', inputSchema: { indexer: z.string().optional() }, annotations: { readOnlyHint: true } },
  jackett_list_indexers: { description: 'List configured Jackett indexers.', inputSchema: {}, annotations: { readOnlyHint: true } },
  jackett_get_category: { description: 'Resolve user-facing category names to Torznab IDs.', inputSchema: { query: z.string().min(1) }, annotations: { readOnlyHint: true } },
  qbittorrent_test_connection: { description: 'Validate qBittorrent authentication and report its version.', inputSchema: {}, annotations: { readOnlyHint: true } },
  qbittorrent_add_magnet: { description: 'Submit a BTIH magnet to qBittorrent; success means acceptance, not completed download.', inputSchema: { magnet_uri: torrentMagnet, save_path: z.string().optional(), category: z.string().optional(), tags: z.array(z.string()).optional(), paused: z.boolean().optional(), skip_checking: z.boolean().optional() } },
  qbittorrent_add_torrent_url: { description: 'Add an HTTP(S) torrent URL to qBittorrent.', inputSchema: { torrent_url: torrentHttpUrl, save_path: z.string().optional(), category: z.string().optional(), tags: z.array(z.string()).optional(), paused: z.boolean().optional(), skip_checking: z.boolean().optional() } },
  qbittorrent_list_torrents: { description: 'List normalized torrents with filtering and sorting.', inputSchema: { filter: z.enum(['all', 'downloading', 'completed', 'paused', 'active', 'inactive']).optional(), category: z.string().optional(), tag: z.string().optional(), sort_by: z.enum(['added_on', 'progress', 'dlspeed', 'upspeed', 'eta', 'name']).optional(), limit: z.number().int().min(1).max(1000).optional() }, annotations: { readOnlyHint: true } },
  qbittorrent_get_torrent: { description: 'Get normalized torrent details by hash.', inputSchema: { hash: torrentHash }, annotations: { readOnlyHint: true } },
  qbittorrent_pause_torrent: { description: 'Pause one or more torrents.', inputSchema: hashesShape, annotations: { idempotentHint: true } },
  qbittorrent_resume_torrent: { description: 'Resume one or more torrents.', inputSchema: hashesShape, annotations: { idempotentHint: true } },
  qbittorrent_delete_torrent: { description: 'Delete torrents; files are kept unless delete_files is true.', inputSchema: { ...hashesShape, delete_files: z.boolean().default(false) }, annotations: { destructiveHint: true } }
};

for (const [alias, canonical] of Object.entries({
  torrent_search: 'jackett_search', torrent_caps: 'jackett_caps', torrent_list_indexers: 'jackett_list_indexers',
  torrent_add: 'qbittorrent_add_magnet', torrent_list: 'qbittorrent_list_torrents', torrent_get: 'qbittorrent_get_torrent',
  torrent_pause: 'qbittorrent_pause_torrent', torrent_resume: 'qbittorrent_resume_torrent', torrent_delete: 'qbittorrent_delete_torrent'
})) {
  toolSpecs[alias] = { ...toolSpecs[canonical], description: `Deprecated compatibility alias for ${canonical}.` };
}
toolSpecs.torrent_add = { description: 'Deprecated compatibility alias for qBittorrent add.', inputSchema: addShape };
toolSpecs.torrent_delete = { ...toolSpecs.torrent_delete, inputSchema: { ...hashesShape, deleteFiles: z.boolean().optional(), delete_files: z.boolean().optional() } };

export function createTorrentServer(config: AppConfig, deps: TorrentDeps = createDefaultTorrentDeps(config)): McpServer {
  const server = new McpServer({ name: 'torrent-mcp', version: PACKAGE_VERSION });
  const registry = createIntegrationRegistry(config, deps.vpnStatusProvider);
  const handlers = createTorrentToolHandlers(config, deps, registry);
  for (const [name, handler] of Object.entries(handlers)) {
    const spec = toolSpecs[name] ?? registry.specs[name];
    server.registerTool(name, { ...spec, inputSchema: z.strictObject(spec.inputSchema) }, async (args: unknown) => mcpJsonContent(await handler(args)));
  }
  return server;
}

async function structured(run: () => Promise<unknown>): Promise<ToolResult> {
  return structuredResult(run, publicErrorMessage);
}

function publicErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    INVALID_ARGUMENT: 'Invalid tool argument',
    NETWORK_GUARD_BLOCKED: 'Network guard blocked this operation',
    TORRENT_NOT_FOUND: 'Torrent was not found',
    JACKETT_AUTH_FAILED: 'Jackett rejected the configured API key',
    JACKETT_UNREACHABLE: 'Could not reach the configured Jackett service',
    JACKETT_REQUEST_FAILED: 'Jackett request failed',
    JACKETT_ADMIN_API_UNAVAILABLE: 'Jackett admin API is unavailable',
    TORZNAB_PARSE_ERROR: 'Jackett returned an invalid Torznab response',
    QBIT_LOGIN_FAILED: 'qBittorrent rejected the configured credentials',
    QBIT_UNREACHABLE: 'Could not reach the configured qBittorrent service',
    QBIT_REQUEST_FAILED: 'qBittorrent request failed',
    JEV_KEY_UNAVAILABLE: 'Configured Jev key file is unavailable',
    JEV_AUTH_FAILED: 'Jev rejected the configured API key',
    JEV_TIMEOUT: 'Jev ranking timed out',
    JEV_REQUEST_FAILED: 'Jev ranking request failed',
    JEV_INVALID_RESPONSE: 'Jev returned an invalid ranking'
  };
  return messages[code] ?? 'The tool operation failed';
}

async function requireNetworkGuard(config: AppConfig, provider: VpnStatusProvider, operation: string): Promise<void> {
  const result = await checkNetworkGuard(config, provider, operation);
  if (!result.allowed) throw new McpError('NETWORK_GUARD_BLOCKED', 'Network guard blocked this operation', result);
}

function objectArg(args: unknown): Record<string, unknown> { return args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {}; }
function stringAt(input: Record<string, unknown>, key: string): string { const value = input[key]; if (typeof value !== 'string' || !value) throw new McpError('INVALID_ARGUMENT', `${key} is required`); return value; }
function optionalStringAt(input: Record<string, unknown>, key: string): string | undefined { const value = input[key]; return typeof value === 'string' && value ? value : undefined; }
function optionalNumberAt(input: Record<string, unknown>, key: string): number | undefined { const value = input[key]; return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function optionalStringArrayAt(input: Record<string, unknown>, key: string): string[] | undefined { const value = input[key]; return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item)) : undefined; }
function optionalNumberArrayAt(input: Record<string, unknown>, key: string): number[] | undefined { const value = input[key]; return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number' && Number.isInteger(item)) : undefined; }
function hashesArg(args: unknown): string[] {
  const input = objectArg(args);
  if (input.hash !== undefined && input.hashes !== undefined) throw invalidArgument('hash', 'Supply either hash or hashes, not both.');
  const hashes = optionalStringArrayAt(input, 'hashes') ?? (typeof input.hash === 'string' ? [input.hash] : undefined);
  if (!hashes?.length) throw invalidArgument('hash', 'Supply hash or a nonempty hashes list.');
  return [...new Set(hashes.map((hash) => hash.toLowerCase()))];
}
function qbitListOptions(args: unknown): QbitListOptions {
  const input = objectArg(args);
  const filter = optionalStringAt(input, 'filter');
  const sort = optionalStringAt(input, 'sort_by');
  const limit = optionalNumberAt(input, 'limit');
  if (filter && !['all', 'downloading', 'completed', 'paused', 'active', 'inactive'].includes(filter)) throw new McpError('INVALID_ARGUMENT', 'invalid qBittorrent filter');
  if (sort && !['added_on', 'progress', 'dlspeed', 'upspeed', 'eta', 'name'].includes(sort)) throw new McpError('INVALID_ARGUMENT', 'invalid qBittorrent sort_by');
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) throw new McpError('INVALID_ARGUMENT', 'limit must be an integer between 1 and 1000');
  return { filter, category: input.category as string | undefined, tag: input.tag as string | undefined, sort, limit };
}
function qbitAddOptions(args: unknown): QbitAddOptions {
  const input = objectArg(args);
  if (input.savepath !== undefined && input.save_path !== undefined) throw invalidArgument('save_path', 'Supply only one of save_path or savepath.');
  if (input.skipChecking !== undefined && input.skip_checking !== undefined) throw invalidArgument('skip_checking', 'Supply only one of skip_checking or skipChecking.');
  if (['url', 'urls', 'magnet_uri', 'torrent_url'].filter((key) => input[key] !== undefined).length !== 1) throw invalidArgument('url', 'Supply exactly one of url, urls, magnet_uri, or torrent_url.');
  const single = optionalStringAt(input, 'url') ?? optionalStringAt(input, 'magnet_uri') ?? optionalStringAt(input, 'torrent_url');
  const urls = optionalStringArrayAt(input, 'urls') ?? (single ? [single] : undefined);
  if (!urls?.length) throw new McpError('INVALID_ARGUMENT', 'url, urls, magnet_uri, or torrent_url is required');
  return { urls, savepath: optionalStringAt(input, 'savepath') ?? optionalStringAt(input, 'save_path'), category: optionalStringAt(input, 'category'), tags: optionalStringArrayAt(input, 'tags'), paused: typeof input.paused === 'boolean' ? input.paused : undefined, skipChecking: typeof input.skipChecking === 'boolean' ? input.skipChecking : typeof input.skip_checking === 'boolean' ? input.skip_checking : undefined };
}
