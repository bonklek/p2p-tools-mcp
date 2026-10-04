import { existsSync, readFileSync } from 'node:fs';
import { readCredentials } from '../setup.js';
import YAML from 'yaml';
import { z } from 'zod';
import { McpError } from './errors.js';
import { ValidationError, validationError } from './diagnostics.js';

export interface AppConfig {
  /** Optional adapters validate independently so one bad service cannot prevent startup. */
  integrations?: unknown;
  /** Jev is opt-in and reads its credential from a local file at request time. */
  jev?: { apiKeyFile: string; model: string; timeoutMs: number };
  vpn: {
    provider: 'nordvpn';
    command: string;
    defaultCountry?: string;
    windowsStatusProvider?: 'nord-egress';
  };
  networkGuard: {
    enabled: boolean;
    requireVpnConnected: boolean;
    guardedOperations: string[];
  };
  jackett: {
    baseUrl: string;
    apiKey?: string;
  };
  qbittorrent: {
    baseUrl: string;
    username?: string;
    password?: string;
  };
  timeouts: {
    commandMs: number;
    httpMs: number;
  };
}

export const DEFAULT_CONFIG: AppConfig = {
  vpn: {
    provider: 'nordvpn',
    command: 'nordvpn'
  },
  networkGuard: {
    enabled: true,
    requireVpnConnected: true,
    guardedOperations: ['torrent_search', 'torrent_caps', 'torrent_list_indexers', 'torrent_add']
  },
  jackett: {
    baseUrl: 'http://127.0.0.1:9117'
  },
  qbittorrent: {
    baseUrl: 'http://127.0.0.1:8080'
  },
  timeouts: {
    commandMs: 15000,
    httpMs: 15000
  }
};

const operationNames = ['torrent_search', 'torrent_caps', 'torrent_list_indexers', 'torrent_add', 'torrent_list', 'torrent_get', 'torrent_pause', 'torrent_resume', 'torrent_delete'] as const;
const timeoutSchema = z.number().int().min(1).max(2_147_483_647);
const configSchema = z.strictObject({
  jev: z.strictObject({
    apiKeyFile: z.string().trim().min(1),
    model: z.string().trim().min(1).default('jev-latest'),
    timeoutMs: z.number().int().min(1).max(120_000).default(15_000)
  }).optional(),
  vpn: z.strictObject({ provider: z.literal('nordvpn'), command: z.string().trim().min(1), defaultCountry: z.string().trim().min(1).optional(), windowsStatusProvider: z.literal('nord-egress').optional() }),
  networkGuard: z.strictObject({ enabled: z.boolean(), requireVpnConnected: z.boolean(), guardedOperations: z.array(z.enum(operationNames)) }),
  jackett: z.strictObject({ baseUrl: z.string(), apiKey: z.string().optional() }),
  qbittorrent: z.strictObject({ baseUrl: z.string(), username: z.string().optional(), password: z.string().optional() }),
  timeouts: z.strictObject({ commandMs: timeoutSchema, httpMs: timeoutSchema })
});

export function loadConfigFromString(yamlText: string | undefined): AppConfig {
  let parsed: unknown;
  try {
    parsed = yamlText?.trim() ? YAML.parse(yamlText) : {};
  } catch {
    throw configError('configuration', 'Use valid YAML; check indentation and delimiters.');
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw configError('configuration', 'Use a YAML object containing configuration sections.');
  }
  return normalizeConfig(parsed as Record<string, unknown>);
}

export function loadConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8')
): AppConfig {
  const path = env.P2P_TOOLS_CONFIG;
  if (!path) return applyEnvOverrides(loadConfigFromString(''), env);
  if (!existsSync(path)) throw new McpError('CONFIG_NOT_FOUND', 'Configured P2P_TOOLS_CONFIG file was not found');
  let yaml: string;
  try { yaml = readFile(path); }
  catch { throw new McpError('CONFIG_UNREADABLE', 'Configured file could not be read'); }
  return applyEnvOverrides(loadConfigFromString(yaml), env);
}

export function loadConfig(): AppConfig {
  return loadConfigFromEnv(process.env);
}

function normalizeConfig(input: Record<string, unknown>): AppConfig {
  const allowed = new Set(['vpn', 'network_guard', 'networkGuard', 'jackett', 'qbittorrent', 'timeouts', 'integrations', 'jev']);
  if (Object.keys(input).some((key) => !allowed.has(key)) || ('network_guard' in input && 'networkGuard' in input)) {
    throw configError('configuration', 'Use only vpn, network_guard (or networkGuard), jackett, qbittorrent, timeouts, integrations, and jev; do not supply both guard spellings.');
  }
  const networkGuardInput = objectAt(input, 'network_guard') ?? objectAt(input, 'networkGuard') ?? {};
  if ('guarded_operations' in networkGuardInput && 'guardedOperations' in networkGuardInput) {
    throw configError('network_guard.guarded_operations', 'Supply only one of guarded_operations or guardedOperations.');
  }
  const { guarded_operations, ...guardFields } = networkGuardInput;
  const guardedOperationsInput = 'guarded_operations' in networkGuardInput ? guarded_operations : networkGuardInput.guardedOperations;
  const config: AppConfig = {
    ...(input.integrations !== undefined ? { integrations: input.integrations } : {}),
    ...(input.jev !== undefined ? { jev: objectAt(input, 'jev') as AppConfig['jev'] } : {}),
    vpn: {
      ...DEFAULT_CONFIG.vpn,
      ...objectAt(input, 'vpn')
    },
    networkGuard: {
      ...DEFAULT_CONFIG.networkGuard,
      ...guardFields,
      guardedOperations: parseStringList(guardedOperationsInput, DEFAULT_CONFIG.networkGuard.guardedOperations)
    },
    jackett: {
      ...DEFAULT_CONFIG.jackett,
      ...objectAt(input, 'jackett')
    },
    qbittorrent: {
      ...DEFAULT_CONFIG.qbittorrent,
      ...objectAt(input, 'qbittorrent')
    },
    timeouts: {
      ...DEFAULT_CONFIG.timeouts,
      ...objectAt(input, 'timeouts')
    }
  };

  return validateConfig(config);
}

function applyEnvOverrides(config: AppConfig, env: NodeJS.ProcessEnv): AppConfig {
  env = { ...readCredentials(env), ...Object.fromEntries(Object.entries(env).filter(([,v]) => v !== undefined)) };
  if (env.SLSKD_API_KEY) {
    const integrations = (config.integrations ?? {}) as Record<string, unknown>;
    const existing = (integrations.slskd ?? {}) as Record<string, unknown>;
    config = { ...config, integrations: { ...integrations, slskd: { ...existing, enabled: existing.enabled ?? true,
      apiKey: env.SLSKD_API_KEY, ...(env.SLSKD_BASE_URL ? { baseUrl: env.SLSKD_BASE_URL } : {}) } } };
  }
  const timeout = env.P2P_HTTP_TIMEOUT_MS ?? env.JACKETT_TIMEOUT_MS ?? env.QBITTORRENT_TIMEOUT_MS;
  const commandTimeout = env.P2P_COMMAND_TIMEOUT_MS;
  const guardEnabled = parseOptionalBoolean(env.P2P_NETWORK_GUARD_ENABLED, 'P2P_NETWORK_GUARD_ENABLED');
  const next: AppConfig = {
    ...(config.integrations !== undefined ? { integrations: config.integrations } : {}),
    ...(config.jev !== undefined ? { jev: config.jev } : {}),
    vpn: {
      ...config.vpn,
      command: env.NORDVPN_COMMAND?.trim() || config.vpn.command,
      defaultCountry: env.NORDVPN_DEFAULT_COUNTRY?.trim() || config.vpn.defaultCountry
    },
    networkGuard: {
      ...config.networkGuard,
      enabled: guardEnabled ?? config.networkGuard.enabled
    },
    jackett: {
      ...config.jackett,
      baseUrl: env.JACKETT_BASE_URL?.trim() || config.jackett.baseUrl,
      apiKey: env.JACKETT_API_KEY?.trim() || config.jackett.apiKey
    },
    qbittorrent: {
      ...config.qbittorrent,
      baseUrl: env.QBITTORRENT_BASE_URL?.trim() || config.qbittorrent.baseUrl,
      username: env.QBITTORRENT_USERNAME?.trim() || config.qbittorrent.username,
      password: env.QBITTORRENT_PASSWORD?.trim() || config.qbittorrent.password
    },
    timeouts: {
      commandMs: parseOptionalPositiveNumber(commandTimeout, 'P2P_COMMAND_TIMEOUT_MS') ?? config.timeouts.commandMs,
      httpMs: parseOptionalPositiveNumber(timeout, 'P2P_HTTP_TIMEOUT_MS/JACKETT_TIMEOUT_MS/QBITTORRENT_TIMEOUT_MS') ?? config.timeouts.httpMs
    }
  };
  return validateConfig(next);
}

function validateConfig(input: unknown): AppConfig {
  const { integrations, ...core } = input as Record<string, unknown>;
  const parsed = configSchema.safeParse(core);
  if (!parsed.success) {
    const fields = Object.fromEntries(Object.entries(configSchema.shape).flatMap(([section, schema]) =>
      [[section, undefined], ...Object.keys(schema instanceof z.ZodOptional ? schema.unwrap().shape : schema.shape).map((key) => [`${section}.${key}`, undefined])]
    ));
    throw validationError(parsed.error, fields, 'CONFIG_INVALID');
  }
  validateUrl(parsed.data.jackett.baseUrl, 'jackett.baseUrl');
  validateUrl(parsed.data.qbittorrent.baseUrl, 'qbittorrent.baseUrl');
  return { ...parsed.data, ...(integrations !== undefined ? { integrations } : {}) };
}

function parseOptionalBoolean(value: string | undefined, key: string): boolean | undefined {
  if (value == null || value === '') return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw configError(key, 'Use true, false, 1, or 0.');
}

function parseOptionalPositiveNumber(value: string | undefined, key: string): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = Number(value);
  if (!timeoutSchema.safeParse(parsed).success) throw configError(key, 'Use an integer between 1 and 2147483647.');
  return parsed;
}

function validateUrl(value: string, key: string): void {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { throw configError(key, 'Use an HTTP(S) URL without credentials, query, or fragment.'); }
}

function parseStringList(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
    throw configError('network_guard.guarded_operations', 'Use a list of supported operation names.');
  }
  return [...value];
}

function objectAt(input: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  if (!(key in input)) return undefined;
  const value = input[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw configError(key, 'Use an object for this configuration section.');
  return value as Record<string, unknown>;
}

function configError(field: string, message: string): ValidationError {
  return new ValidationError('CONFIG_INVALID', [{ field, message }]);
}
