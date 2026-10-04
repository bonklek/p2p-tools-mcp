import type { AppConfig } from './shared/config.js';
import { loadConfigFromEnv } from './shared/config.js';
import type { ToolResult } from './shared/tool-result.js';
import { PACKAGE_VERSION } from './shared/version.js';
import { createDefaultTorrentDeps, createTorrentToolHandlers } from './torrent/server.js';
import { createVpnToolHandlers } from './vpn/server.js';
import { McpError } from './shared/errors.js';
import { publicDiagnostic, requiredSchemaFields } from './shared/diagnostics.js';
import type { DoctorReport } from './doctor.js';
import { integrationOperations } from './integrations/registry.js';
import { runSlskdBulk, type BulkOptions } from './bulk/slskd-bulk.js';
import { collectCredentials } from './setup.js';
import { runMusicCli } from './music/workflow.js';

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
  'setup status': { tool: 'p2p_setup_status', summary: 'Check Soulseek setup and return a safe user credential-entry path.' },
  'jev rank': { tool: 'jev_rank', summary: 'Rank supplied music candidates and preferences with Jev without downloading.', options: { query: stringOption('query') }, required: ['query', 'candidates'], stdinKeys: ['candidates', 'preferences'] },
  'slskd rank': { tool: 'slskd_rank', summary: 'Filter and rank an existing Soulseek search with Jev.', options: { query: stringOption('query'), 'search-id': stringOption('search_id'), limit: numberOption('limit') }, required: ['search_id'], stdinKeys: ['filters', 'preferences', 'preferred_users'] },
  'basket integrations': { tool: 'p2p_integrations', summary: 'List optional integration configuration states.' },
  'basket search': { tool: 'p2p_search', summary: 'Search configured providers and preserve partial or pending outcomes.', options: { query: stringOption('query'), providers: stringsOption('providers'), limit: numberOption('limit') }, required: ['query'] },
  doctor: { tool: 'p2p_doctor', summary: 'Check configuration, service access, and host VPN guard readiness (read-only).' },
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

// Shared adapter metadata supplies both MCP schemas and CLI command discovery.
for (const operation of integrationOperations) {
  const privateFields = ['source', 'folder', 'device', 'username', 'filters'];
  const options = Object.fromEntries(Object.keys(operation.schema).filter((key) => !privateFields.includes(key)).map((key) => {
    const spec = ['limit', 'offset', 'page', 'max_bytes', 'indexer_id'].includes(key) ? numberOption(key)
      : ['paused', 'delete_files'].includes(key) ? booleanOption(key)
      : key === 'indexer_ids' ? numbersOption(key)
      : ['hashes', 'file_ids'].includes(key) ? stringsOption(key) : stringOption(key);
    return [key.replaceAll('_', '-'), spec];
  }));
  COMMANDS[`${operation.service.replaceAll('_', '-')} ${operation.action.replaceAll('_', '-')}`] = {
    tool: `${operation.service}_${operation.action}`, summary: operation.description, options,
    required: requiredSchemaFields(operation.schema),
    stdinKeys: Object.keys(operation.schema).filter((key) => privateFields.includes(key)), requiresConfirmation: operation.destructive
  };
}

export async function runCli(argv: string[], runtime: CliRuntime = {}): Promise<number> {
  const stdout = runtime.stdout ?? ((text) => process.stdout.write(text));
  const stderr = runtime.stderr ?? ((text) => process.stderr.write(text));

  try {
    if (argv[0] === 'music') return await runMusicCli(argv.slice(1), runtime.env ?? process.env, stdout, stderr);
    if (argv[0] === 'setup' && argv[1] === 'credentials') {
      if (argv.length === 3 && argv[2] === '--help') { stdout('Usage: p2p-tools setup credentials\nEnter local slskd access in a hidden interactive prompt. No sensitive arguments are accepted.\n'); return 0; }
      if (argv.length !== 2) throw new CliUsageError('setup credentials accepts no secret arguments; run it in a local terminal');
      await collectCredentials(runtime.env ?? process.env); return 0;
    }
    if (!argv.length || argv[0] === '--help' || argv[0] === 'help') {
      stdout(helpText());
      return 0;
    }
    if (argv.length === 1 && argv[0] === '--version') {
      stdout(`${CLI_VERSION}\n`);
      return 0;
    }
    if (argv[0] === 'slskd' && argv[1] === 'bulk') {
      if (argv.length === 3 && argv[2] === '--help') {
        stdout('Usage: p2p-tools slskd bulk --manifest <path> [--state <path>] [--approvals <path>] [--plan] [--download] [--retry-errors] [--max-items <n>] [--download-budget-bytes <n>] [--progress]\nSearch and select locally; --download explicitly queues selections. State resumes safely.\n');
        return 0;
      }
      const options = parseBulkOptions(argv.slice(2));
      if (argv.includes('--progress')) options.onProgress = (processed, total) => writeJson(stderr, { processed, total }, true);
      try {
        const handlers = options.plan ? {} : (runtime.torrentHandlers ?? defaultTorrentHandlers)((runtime.loadConfig ?? loadConfigFromEnv)(runtime.env ?? process.env));
        const result = await runSlskdBulk(options, handlers);
        writeJson(stdout, { ok: true, data: result }, true);
        const counts = result.counts as Record<string, number> | undefined;
        return (counts?.error ?? 0) || (counts?.download_intent ?? 0) || result.stopped_reason ? 1 : 0;
      } catch (error) {
        writeJson(stderr, { ok: false, error: { code: 'BULK_ERROR', message: publicBulkError(error) } }, true);
        return 2;
      }
    }
    if ((argv.length === 3 && argv[2] === '--help') || (argv.length === 2 && argv[0] === 'doctor' && argv[1] === '--help')) {
      const key = argv[0] === 'doctor' ? 'doctor' : `${argv[0] === 'qbit' ? 'qbittorrent' : argv[0]} ${argv[1]}`;
      if (!COMMANDS[key]) throw new CliUsageError('Unknown command; run p2p-tools --help');
      stdout(commandHelp(key, COMMANDS[key]));
      return 0;
    }

    const parsed = await parseInvocation(argv, runtime.readStdin ?? defaultReadStdin);
    const env = runtime.env ?? process.env;
    let config: AppConfig;
    try {
      config = (runtime.loadConfig ?? loadConfigFromEnv)(env);
    } catch (error) {
      const diagnostic = error instanceof McpError && ['CONFIG_INVALID', 'CONFIG_NOT_FOUND', 'CONFIG_UNREADABLE'].includes(error.code)
        ? { ok: false, error: publicDiagnostic(error, 'CLI configuration failed') } : cliError('CONFIG_ERROR', 'CLI configuration failed');
      writeJson(stderr, diagnostic, parsed.compact);
      return 2;
    }

    const handlers = {
      ...(runtime.vpnHandlers ?? createVpnToolHandlers)(config),
      ...(runtime.torrentHandlers ?? defaultTorrentHandlers)(config)
    };
    const handler = handlers[parsed.command.tool];
    if (!handler) {
      writeJson(stderr, { ok: false, error: { code: 'INTEGRATION_UNAVAILABLE', message: 'This command is disabled or misconfigured.', next_action: 'Enable and configure the integration in the integrations section, then rerun doctor.' } }, parsed.compact);
      return 1;
    }

    const result = await handler(parsed.args);
    writeJson(stdout, result, parsed.compact);
    if (result.ok && parsed.command.tool === 'p2p_doctor') return (result.data as DoctorReport).status === 'blocked' ? 1 : 0;
    if (result.ok && result.data && typeof result.data === 'object' && (['failed', 'partial'].includes(String((result.data as { outcome?: unknown }).outcome)) || ['failed', 'partial'].includes(String((result.data as { status?: unknown }).status)))) return 1;
    return result.ok ? 0 : result.error.code === 'INVALID_ARGUMENT' ? 2 : 1;
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

function parseBulkOptions(argv: string[]): BulkOptions {
  let manifestPath: string | undefined;
  let statePath: string | undefined;
  let approvalsPath: string | undefined;
  let plan = false;
  let download = false;
  let retryErrors = false;
  let maxItems: number | undefined;
  let downloadBudgetBytes: number | undefined;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--plan') plan = true;
    else if (token === '--download') download = true;
    else if (token === '--retry-errors') retryErrors = true;
    else if (token === '--progress') continue;
    else if (token === '--manifest' || token === '--state' || token === '--approvals' || token === '--max-items' || token === '--download-budget-bytes') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new CliUsageError(`Missing value for ${token}`);
      if (token === '--manifest') manifestPath = value;
      else if (token === '--state') statePath = value;
      else if (token === '--approvals') approvalsPath = value;
      else if(token === '--download-budget-bytes') { downloadBudgetBytes=Number(value);if(!Number.isSafeInteger(downloadBudgetBytes)||downloadBudgetBytes<0)throw new CliUsageError('--download-budget-bytes must be a nonnegative integer'); }
      else { maxItems = Number(value); if (!Number.isSafeInteger(maxItems) || maxItems < 1) throw new CliUsageError('--max-items must be a positive integer'); }
    } else throw new CliUsageError('Unknown bulk option');
  }
  if (!manifestPath) throw new CliUsageError('--manifest is required');
  if (plan && download) throw new CliUsageError('--plan and --download cannot be combined');
  return { manifestPath, statePath: statePath ?? `${manifestPath}.state.json`, approvalsPath, plan, download, retryErrors, maxItems, downloadBudgetBytes };
}

function publicBulkError(error: unknown): string {
  const safe = new Set([
    'Manifest and state paths must differ', 'Track IDs must be unique', 'Approval IDs must be unique',
    'Approval contains an unknown track ID', 'Combined preferences cannot exceed 15 per track',
    'State does not match this manifest', 'Batch state is locked by another run',
    'slskd search and results must be configured', 'slskd download and batch inspection must be configured',
    'Jev must be configured for auto_select_jev'
  ]);
  if (error instanceof Error && safe.has(error.message)) return error.message;
  if (error instanceof Error && error.message.startsWith('Approval for ')) return 'An approval does not match a saved public candidate';
  return 'Check the manifest, approvals, state path, and integration configuration';
}

interface ParsedInvocation {
  command: CommandSpec;
  args: Record<string, unknown>;
  compact: boolean;
}

async function parseInvocation(argv: string[], readStdin: () => Promise<string>): Promise<ParsedInvocation> {
  const doctor = argv[0] === 'doctor';
  if (!doctor && (argv.length < 2 || argv[0].startsWith('-') || argv[1].startsWith('-'))) {
    throw new CliUsageError('Expected a command group and action; run p2p-tools --help');
  }
  const domain = argv[0] === 'qbit' ? 'qbittorrent' : argv[0];
  const key = doctor ? 'doctor' : `${domain} ${argv[1]}`;
  const command = COMMANDS[key];
  if (!command) throw new CliUsageError('Unknown command; run p2p-tools --help');

  const values: Record<string, unknown> = {};
  let compact = false;
  let stdin = false;
  let confirmed = false;
  const options = command.options ?? {};

  for (let index = doctor ? 1 : 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--compact') { compact = true; continue; }
    if (token === '--stdin') {
      if (doctor) throw new CliUsageError('doctor accepts --compact or --help; it does not read standard input');
      stdin = true; continue;
    }
    if (token === '--yes') {
      if (!command.requiresConfirmation) throw new CliUsageError('--yes is only valid for commands requiring destructive-action confirmation');
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
    if (args[required] === undefined || args[required] === '') throw new CliUsageError(`Required field ${required} is missing; run p2p-tools ${key} --help`);
  }
  for (const group of command.oneOf ?? []) {
    if (!group.some((name) => hasValue(args[name]))) throw new CliUsageError(`Supply ${group.join(' or ')}; run p2p-tools ${key} --help`);
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

function commandHelp(key: string, command: CommandSpec): string {
  if (key === 'doctor') return 'Usage: p2p-tools doctor [--compact]\nRead-only checks: configuration, Jackett access and indexers, qBittorrent access and API family, host VPN guard, and configured optional integrations.\nOptional failures are reported separately; other integrations remain usable.\nTraffic isolation is not verified. No searches or torrent or VPN changes are made.\nExit codes: 0 = checks passed or warnings only; 1 = blocked core check; 2 = configuration or usage error.\n';
  const options = Object.entries(command.options ?? {}).map(([name, spec]) =>
    `  --${name}${spec.kind === 'boolean' ? '[=true|false]' : ' <value>'}  JSON field: ${spec.key}`
  );
  const stdinKeys = command.stdinKeys?.length ? `\nAdditional JSON fields via --stdin: ${command.stdinKeys.join(', ')}\n` : '';
  const required = command.required?.length ? `Required fields: ${command.required.join(', ')}\n` : '';
  const target = command.oneOf?.length ? `Supply one of: ${command.oneOf.map((group) => group.join(' or ')).join('; ')}\n` : '';
  const confirmation = command.requiresConfirmation ? command.tool.endsWith('delete') || command.tool === 'qbittorrent_delete_torrent'
    ? 'Requires --yes; downloaded files are retained unless delete_files is true.\n' : 'Requires --yes to change content retention.\n' : '';
  return `Usage: p2p-tools ${key} [options]\n${command.summary}\n\n${options.join('\n')}\n${stdinKeys}${required}${target}${confirmation}\nUse --stdin for one JSON object, --compact for one-line output.\n`;
}

export function helpText(): string {
  const commands = Object.entries(COMMANDS)
    .map(([name, command]) => `  ${name.padEnd(27)} ${command.summary}`)
    .join('\n');
  return `p2p-tools ${CLI_VERSION}\n\nUsage:\n  p2p-tools <group> <action> [options]\n\nCommands:\n  slskd bulk                 Process a resumable song manifest with compact output.\n  setup credentials          Collect service access in a hidden local prompt.\n  music <action>             Plan, start, run, inspect, or pause Android delivery.\n${commands}\n\nGlobal options:\n  --stdin     Merge a JSON object from standard input into command arguments.\n  --compact   Print compact one-line JSON.\n  --yes       Confirm a destructive command such as delete or pin-remove.\n  --help      Show this help.\n  --version   Show the version.\n\nConfiguration:\n  Set P2P_TOOLS_CONFIG to the YAML configuration path. Existing environment\n  overrides documented in docs/user-guide.md are also supported.\n`;
}
