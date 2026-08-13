import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppConfig } from '../shared/config.js';
import { McpError } from '../shared/errors.js';
import { checkNetworkGuard, type VpnStatusProvider } from '../shared/network-guard.js';
import { mcpJsonContent, structuredResult, type ToolResult } from '../shared/tool-result.js';
import { PACKAGE_VERSION } from '../shared/version.js';
import { NordVpnClient } from '../vpn/nordvpn.js';
import { lookupCategory } from './categories.js';
import { JackettClient } from './jackett-client.js';
import { QbitClient } from './qbit-client.js';
import type { QbitAddOptions, QbitListOptions } from './qbit-types.js';

export interface TorrentDeps {
  jackett: Pick<JackettClient, 'search' | 'caps' | 'listIndexers' | 'testConnection'>;
  qbit: Pick<QbitClient, 'testConnection' | 'add' | 'list' | 'get' | 'pause' | 'resume' | 'delete'>;
  vpnStatusProvider: VpnStatusProvider;
}

type ToolHandler = (args: unknown) => Promise<ToolResult>;

export function createDefaultTorrentDeps(config: AppConfig): TorrentDeps {
  const vpnClient = new NordVpnClient({ command: config.vpn.command, timeoutMs: config.timeouts.commandMs });
  return {
    jackett: new JackettClient({ ...config.jackett, timeoutMs: config.timeouts.httpMs }),
    qbit: new QbitClient({ ...config.qbittorrent, timeoutMs: config.timeouts.httpMs }),
    vpnStatusProvider: () => vpnClient.status()
  };
}

export function createTorrentToolHandlers(config: AppConfig, deps: TorrentDeps): Record<string, ToolHandler> {
  const jackettSearch = (args: unknown) => structured(async () => {
    await requireNetworkGuard(config, deps.vpnStatusProvider, 'torrent_search');
    const input = objectArg(args);
    const searchType = optionalStringAt(input, 'search_type') ?? 'search';
    if (!['search', 'tvsearch', 'movie', 'music', 'book'].includes(searchType)) throw new McpError('INVALID_ARGUMENT', 'invalid search_type');
    if (searchType !== 'tvsearch' && (input.season !== undefined || input.episode !== undefined)) throw new McpError('INVALID_ARGUMENT', 'season and episode are only valid for tvsearch');
    if (searchType !== 'movie' && input.imdb_id !== undefined) throw new McpError('INVALID_ARGUMENT', 'imdb_id is only valid for movie search');
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
    return deps.qbit.add(qbitAddOptions({ ...objectArg(args), url: stringAt(objectArg(args), 'torrent_url') }));
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
    return deps.qbit.delete(hashesArg(args), Boolean(input.delete_files ?? input.deleteFiles));
  });

  const handlers: Record<string, ToolHandler> = {
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

  return Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, async (args: unknown) => {
    const parsed = z.object(toolSpecs[name].inputSchema).safeParse(args ?? {});
    if (!parsed.success) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Invalid tool argument' } };
    return handler(parsed.data);
  }]));
}

const searchShape = {
  query: z.string().optional(),
  indexer: z.string().optional(),
  search_type: z.enum(['search', 'tvsearch', 'movie', 'music', 'book']).default('search'),
  categories: z.array(z.number().int()).optional(),
  season: z.number().int().positive().optional(),
  episode: z.string().optional(),
  imdb_id: z.string().regex(/^tt\d+$/).optional(),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0)
};
const addShape = {
  url: z.string().optional(), urls: z.array(z.string()).optional(), magnet_uri: z.string().optional(), torrent_url: z.string().optional(),
  savepath: z.string().optional(), save_path: z.string().optional(), category: z.string().optional(), tags: z.array(z.string()).optional(),
  paused: z.boolean().optional(), skipChecking: z.boolean().optional(), skip_checking: z.boolean().optional()
};
const hashesShape = { hash: z.string().optional(), hashes: z.array(z.string()).optional() };
const torrentHttpUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
});

const toolSpecs: Record<string, { description: string; inputSchema: z.ZodRawShape; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } }> = {
  jackett_test_connection: { description: 'Validate Jackett connectivity and API-key access.', inputSchema: {}, annotations: { readOnlyHint: true } },
  jackett_search: { description: 'Search Jackett using typed Torznab modes and normalized results.', inputSchema: searchShape, annotations: { readOnlyHint: true } },
  jackett_caps: { description: 'Read normalized Torznab capabilities.', inputSchema: { indexer: z.string().optional() }, annotations: { readOnlyHint: true } },
  jackett_list_indexers: { description: 'List configured Jackett indexers.', inputSchema: {}, annotations: { readOnlyHint: true } },
  jackett_get_category: { description: 'Resolve user-facing category names to Torznab IDs.', inputSchema: { query: z.string().min(1) }, annotations: { readOnlyHint: true } },
  qbittorrent_test_connection: { description: 'Validate qBittorrent authentication and report its version.', inputSchema: {}, annotations: { readOnlyHint: true } },
  qbittorrent_add_magnet: { description: 'Add a magnet URI to qBittorrent.', inputSchema: { magnet_uri: z.string().startsWith('magnet:'), save_path: z.string().optional(), category: z.string().optional(), tags: z.array(z.string()).optional(), paused: z.boolean().optional(), skip_checking: z.boolean().optional() } },
  qbittorrent_add_torrent_url: { description: 'Add an HTTP(S) torrent URL to qBittorrent.', inputSchema: { torrent_url: torrentHttpUrl, save_path: z.string().optional(), category: z.string().optional(), tags: z.array(z.string()).optional(), paused: z.boolean().optional(), skip_checking: z.boolean().optional() } },
  qbittorrent_list_torrents: { description: 'List normalized torrents with filtering and sorting.', inputSchema: { filter: z.string().optional(), category: z.string().optional(), tag: z.string().optional(), sort_by: z.string().optional(), limit: z.number().int().min(1).max(1000).optional() }, annotations: { readOnlyHint: true } },
  qbittorrent_get_torrent: { description: 'Get normalized torrent details by hash.', inputSchema: { hash: z.string().min(1) }, annotations: { readOnlyHint: true } },
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
  const handlers = createTorrentToolHandlers(config, deps);
  for (const [name, handler] of Object.entries(handlers)) {
    const spec = toolSpecs[name];
    server.registerTool(name, spec, async (args: unknown) => mcpJsonContent(await handler(args)));
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
    QBIT_REQUEST_FAILED: 'qBittorrent request failed'
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
function hashesArg(args: unknown): string[] { const input = objectArg(args); const hashes = optionalStringArrayAt(input, 'hashes') ?? (typeof input.hash === 'string' ? [input.hash] : undefined); if (!hashes?.length) throw new McpError('INVALID_ARGUMENT', 'hash or hashes is required'); return hashes; }
function qbitListOptions(args: unknown): QbitListOptions {
  const input = objectArg(args);
  const filter = optionalStringAt(input, 'filter');
  const sort = optionalStringAt(input, 'sort_by');
  const limit = optionalNumberAt(input, 'limit');
  if (filter && !['all', 'downloading', 'completed', 'paused', 'active', 'inactive'].includes(filter)) throw new McpError('INVALID_ARGUMENT', 'invalid qBittorrent filter');
  if (sort && !['added_on', 'progress', 'dlspeed', 'upspeed', 'eta', 'name'].includes(sort)) throw new McpError('INVALID_ARGUMENT', 'invalid qBittorrent sort_by');
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) throw new McpError('INVALID_ARGUMENT', 'limit must be an integer between 1 and 1000');
  return { filter, category: optionalStringAt(input, 'category'), tag: optionalStringAt(input, 'tag'), sort, limit };
}
function qbitAddOptions(args: unknown): QbitAddOptions {
  const input = objectArg(args);
  const single = optionalStringAt(input, 'url') ?? optionalStringAt(input, 'magnet_uri') ?? optionalStringAt(input, 'torrent_url');
  const urls = optionalStringArrayAt(input, 'urls') ?? (single ? [single] : undefined);
  if (!urls?.length) throw new McpError('INVALID_ARGUMENT', 'url, urls, magnet_uri, or torrent_url is required');
  return { urls, savepath: optionalStringAt(input, 'savepath') ?? optionalStringAt(input, 'save_path'), category: optionalStringAt(input, 'category'), tags: optionalStringArrayAt(input, 'tags'), paused: typeof input.paused === 'boolean' ? input.paused : undefined, skipChecking: typeof input.skipChecking === 'boolean' ? input.skipChecking : typeof input.skip_checking === 'boolean' ? input.skip_checking : undefined };
}
