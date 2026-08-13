import type { AppConfig } from './shared/config.js';
import { loadConfigFromEnv } from './shared/config.js';
import type { ToolResult } from './shared/tool-result.js';
import { PACKAGE_VERSION } from './shared/version.js';
import { createDefaultTorrentDeps, createTorrentToolHandlers } from './torrent/server.js';
import { createVpnToolHandlers } from './vpn/server.js';

export const CLI_VERSION = PACKAGE_VERSION;

type ToolHandler = (args: unknown) => Promise<ToolResult>;
type OptionKind = 'string' | 'number' | 'boolean' | 'strings' | 'numbers';

interface OptionSpec {
  key: string;
  kind: OptionKind;
}

interface CommandSpec {
  tool: string;
  summary: string;
  options?: Record<string, OptionSpec>;
  required?: string[];
  oneOf?: string[][];
  stdinKeys?: string[];
  requiresConfirmation?: boolean;
}

export interface CliRuntime {
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  readStdin?: () => Promise<string>;
  loadConfig?: (env: NodeJS.ProcessEnv) => AppConfig;
  torrentHandlers?: (config: AppConfig) => Record<string, ToolHandler>;
  vpnHandlers?: (config: AppConfig) => Record<string, ToolHandler>;
}

class CliUsageError extends Error {}

const stringOption = (key: string): OptionSpec => ({ key, kind: 'string' });
const numberOption = (key: string): OptionSpec => ({ key, kind: 'number' });
const booleanOption = (key: string): OptionSpec => ({ key, kind: 'boolean' });
const stringsOption = (key: string): OptionSpec => ({ key, kind: 'strings' });
const numbersOption = (key: string): OptionSpec => ({ key, kind: 'numbers' });

const COMMANDS: Record<string, CommandSpec> = {
  'vpn status': { tool: 'vpn_status', summary: 'Return VPN connection status.' },
  'vpn connect': { tool: 'vpn_connect', summary: 'Connect the VPN.', options: { country: stringOption('country') } },
  'vpn disconnect': { tool: 'vpn_disconnect', summary: 'Disconnect the VPN.' },
  'vpn public-ip': { tool: 'vpn_public_ip', summary: 'Return the current public IP.' },
  'vpn require-active': { tool: 'vpn_require_active', summary: 'Fail unless the VPN is connected.' },

  'jackett test': { tool: 'jackett_test_connection', summary: 'Test Jackett connectivity and authentication.' },
  'jackett search': {
    tool: 'jackett_search',
    summary: 'Search Jackett.',
    options: {
      query: stringOption('query'), indexer: stringOption('indexer'), type: stringOption('search_type'),
      category: numbersOption('categories'), season: numberOption('season'), episode: stringOption('episode'),
      'imdb-id': stringOption('imdb_id'), limit: numberOption('limit'), offset: numberOption('offset')
    }
  },
  'jackett caps': { tool: 'jackett_caps', summary: 'Read Jackett capabilities.', options: { indexer: stringOption('indexer') } },
  'jackett indexers': { tool: 'jackett_list_indexers', summary: 'List configured Jackett indexers.' },
  'jackett category': {
    tool: 'jackett_get_category', summary: 'Resolve a category name to Torznab IDs.',
    options: { query: stringOption('query') }, required: ['query']
  },

  'qbittorrent test': { tool: 'qbittorrent_test_connection', summary: 'Test qBittorrent connectivity and authentication.' },
  'qbittorrent add-magnet': {
    tool: 'qbittorrent_add_magnet', summary: 'Add a magnet URI.',
    options: {
      category: stringOption('category'), tag: stringsOption('tags'), paused: booleanOption('paused'),
      'skip-checking': booleanOption('skip_checking')
    }, required: ['magnet_uri'], stdinKeys: ['magnet_uri', 'save_path']
  },
  'qbittorrent add-url': {
    tool: 'qbittorrent_add_torrent_url', summary: 'Add a torrent URL.',
    options: {
      category: stringOption('category'), tag: stringsOption('tags'), paused: booleanOption('paused'),
      'skip-checking': booleanOption('skip_checking')
    }, required: ['torrent_url'], stdinKeys: ['torrent_url', 'save_path']
  },
  'qbittorrent list': {
    tool: 'qbittorrent_list_torrents', summary: 'List torrents.',
    options: {
      filter: stringOption('filter'), category: stringOption('category'), tag: stringOption('tag'),
      'sort-by': stringOption('sort_by'), limit: numberOption('limit')
    }
  },
  'qbittorrent get': {
    tool: 'qbittorrent_get_torrent', summary: 'Get one torrent.',
    options: { hash: stringOption('hash') }, required: ['hash']
  },
  'qbittorrent pause': {
    tool: 'qbittorrent_pause_torrent', summary: 'Pause one or more torrents.',
    options: { hash: stringsOption('hashes') }, oneOf: [['hash', 'hashes']], stdinKeys: ['hash', 'hashes']
  },
  'qbittorrent resume': {
    tool: 'qbittorrent_resume_torrent', summary: 'Resume one or more torrents.',
    options: { hash: stringsOption('hashes') }, oneOf: [['hash', 'hashes']], stdinKeys: ['hash', 'hashes']
  },
  'qbittorrent delete': {
    tool: 'qbittorrent_delete_torrent', summary: 'Delete one or more torrents.',
    options: { hash: stringsOption('hashes'), 'delete-files': booleanOption('delete_files') },
    oneOf: [['hash', 'hashes']], stdinKeys: ['hash', 'hashes', 'delete_files'], requiresConfirmation: true
  }
};

export async function runCli(argv: string[], runtime: CliRuntime = {}): Promise<number> {
  const stdout = runtime.stdout ?? ((text) => process.stdout.write(text));
  const stderr = runtime.stderr ?? ((text) => process.stderr.write(text));

  try {
    if (!argv.length || argv[0] === '--help' || argv[0] === 'help') {
      stdout(helpText());
      return 0;
    }
    if (argv.length === 1 && argv[0] === '--version') {
      stdout(`${CLI_VERSION}\n`);
      return 0;
    }

    const parsed = await parseInvocation(argv, runtime.readStdin ?? defaultReadStdin);
    const env = runtime.env ?? process.env;
    let config: AppConfig;
    try {
      config = (runtime.loadConfig ?? loadConfigFromEnv)(env);
    } catch {
      writeJson(stderr, cliError('CONFIG_ERROR', 'CLI configuration failed'), parsed.compact);
      return 2;
    }

    const handlers = {
      ...(runtime.vpnHandlers ?? createVpnToolHandlers)(config),
      ...(runtime.torrentHandlers ?? defaultTorrentHandlers)(config)
    };
    const handler = handlers[parsed.command.tool];
    if (!handler) {
      writeJson(stderr, cliError('CLI_ERROR', 'CLI command is unavailable'), parsed.compact);
      return 1;
    }

    const result = await handler(parsed.args);
    writeJson(stdout, result, parsed.compact);
    return result.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof CliUsageError) {
      writeJson(stderr, cliError('CLI_USAGE', error.message), false);
      return 2;
    }
    writeJson(stderr, cliError('CLI_ERROR', 'CLI operation failed'), false);
    return 1;
  }
}

function defaultTorrentHandlers(config: AppConfig): Record<string, ToolHandler> {
  return createTorrentToolHandlers(config, createDefaultTorrentDeps(config));
}

interface ParsedInvocation {
  command: CommandSpec;
  args: Record<string, unknown>;
  compact: boolean;
}

async function parseInvocation(argv: string[], readStdin: () => Promise<string>): Promise<ParsedInvocation> {
  if (argv.length < 2 || argv[0].startsWith('-') || argv[1].startsWith('-')) {
    throw new CliUsageError('Expected a command group and action; run p2p-tools --help');
  }
  const domain = argv[0] === 'qbit' ? 'qbittorrent' : argv[0];
  const key = `${domain} ${argv[1]}`;
  const command = COMMANDS[key];
  if (!command) throw new CliUsageError('Unknown command; run p2p-tools --help');

  const values: Record<string, unknown> = {};
  let compact = false;
  let stdin = false;
  let confirmed = false;
  const options = command.options ?? {};

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--compact') { compact = true; continue; }
    if (token === '--stdin') { stdin = true; continue; }
    if (token === '--yes') {
      if (!command.requiresConfirmation) throw new CliUsageError('--yes is only valid for qbittorrent delete');
      confirmed = true;
      continue;
    }
    if (!token.startsWith('--')) throw new CliUsageError('Unexpected positional argument');

    const equals = token.indexOf('=');
    const name = token.slice(2, equals >= 0 ? equals : undefined);
    const spec = options[name];
    if (!spec) throw new CliUsageError('Unknown option');
    const inline = equals >= 0 ? token.slice(equals + 1) : undefined;
    if (spec.kind === 'boolean') {
      const value = inline === undefined ? true : parseBoolean(inline);
      values[spec.key] = value;
      continue;
    }
    const raw = inline ?? argv[++index];
    if (raw === undefined || raw.startsWith('--')) throw new CliUsageError(`Option --${name} requires a value`);
    assignValue(values, spec, raw);
  }

  let args: Record<string, unknown> = {};
  if (stdin) {
    let parsed: unknown;
    try { parsed = JSON.parse(await readStdin()); }
    catch { throw new CliUsageError('Standard input must contain one JSON object'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CliUsageError('Standard input must contain one JSON object');
    }
    args = parsed as Record<string, unknown>;
    const allowed = new Set([...(command.stdinKeys ?? []), ...Object.values(options).map((option) => option.key)]);
    if (Object.keys(args).some((name) => !allowed.has(name))) throw new CliUsageError('Standard input contains an unknown field');
  }
  args = { ...args, ...values };

  for (const required of command.required ?? []) {
    if (args[required] === undefined || args[required] === '') throw new CliUsageError('A required option is missing');
  }
  for (const group of command.oneOf ?? []) {
    if (!group.some((name) => hasValue(args[name]))) throw new CliUsageError('A required option is missing');
  }
  if (command.requiresConfirmation && !confirmed) {
    throw new CliUsageError('This command requires --yes');
  }
  return { command, args, compact };
}

function assignValue(target: Record<string, unknown>, spec: OptionSpec, raw: string): void {
  if (spec.kind === 'string') { target[spec.key] = raw; return; }
  if (spec.kind === 'number') { target[spec.key] = parseNumber(raw); return; }
  const parts = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (!parts.length) throw new CliUsageError('Option value must not be empty');
  const converted = spec.kind === 'numbers' ? parts.map(parseNumber) : parts;
  target[spec.key] = [...((target[spec.key] as unknown[] | undefined) ?? []), ...converted];
}

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new CliUsageError('Option value must be a number');
  return parsed;
}

function parseBoolean(value: string): boolean {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new CliUsageError('Boolean option must be true or false');
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0);
}

function cliError(code: string, message: string): ToolResult {
  return { ok: false, error: { code, message } };
}

function writeJson(write: (text: string) => void, value: unknown, compact: boolean): void {
  write(`${JSON.stringify(value, null, compact ? undefined : 2)}\n`);
}

async function defaultReadStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export function helpText(): string {
  const commands = Object.entries(COMMANDS)
    .map(([name, command]) => `  ${name.padEnd(27)} ${command.summary}`)
    .join('\n');
  return `p2p-tools ${CLI_VERSION}\n\nUsage:\n  p2p-tools <group> <action> [options]\n\nCommands:\n${commands}\n\nGlobal options:\n  --stdin     Merge a JSON object from standard input into command arguments.\n  --compact   Print compact one-line JSON.\n  --yes       Confirm qbittorrent delete.\n  --help      Show this help.\n  --version   Show the version.\n\nConfiguration:\n  Set P2P_TOOLS_CONFIG to the YAML configuration path. Existing environment\n  overrides documented in docs/user-guide.md are also supported.\n`;
}
