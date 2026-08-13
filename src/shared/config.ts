import { existsSync, readFileSync } from 'node:fs';
import YAML from 'yaml';
import { McpError } from './errors.js';

export interface AppConfig {
  vpn: {
    provider: 'nordvpn';
    command: string;
    defaultCountry?: string;
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

export function loadConfigFromString(yamlText: string | undefined): AppConfig {
  let parsed: unknown;
  try {
    parsed = yamlText?.trim() ? YAML.parse(yamlText) : {};
  } catch {
    throw new McpError('CONFIG_INVALID', 'Configuration YAML could not be parsed');
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new McpError('CONFIG_INVALID', 'Configuration must be a YAML object');
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
  return applyEnvOverrides(loadConfigFromString(readFile(path)), env);
}

export function loadConfig(): AppConfig {
  return loadConfigFromEnv(process.env);
}

function normalizeConfig(input: Record<string, unknown>): AppConfig {
  const networkGuardInput = objectAt(input, 'network_guard') ?? objectAt(input, 'networkGuard') ?? {};
  const guardedOperationsInput = networkGuardInput.guarded_operations ?? networkGuardInput.guardedOperations;
  const config: AppConfig = {
    vpn: {
      ...DEFAULT_CONFIG.vpn,
      ...objectAt(input, 'vpn')
    },
    networkGuard: {
      ...DEFAULT_CONFIG.networkGuard,
      ...networkGuardInput,
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

  if (config.vpn.provider !== 'nordvpn') throw new McpError('CONFIG_INVALID', 'Only nordvpn provider is supported');
  if (!config.vpn.command) throw new McpError('CONFIG_INVALID', 'vpn.command is required');
  validateUrl(config.jackett.baseUrl, 'jackett.baseUrl');
  validateUrl(config.qbittorrent.baseUrl, 'qbittorrent.baseUrl');
  if (config.timeouts.commandMs <= 0 || config.timeouts.httpMs <= 0) {
    throw new McpError('CONFIG_INVALID', 'timeouts must be positive');
  }
  return config;
}

function applyEnvOverrides(config: AppConfig, env: NodeJS.ProcessEnv): AppConfig {
  const timeout = env.P2P_HTTP_TIMEOUT_MS ?? env.JACKETT_TIMEOUT_MS ?? env.QBITTORRENT_TIMEOUT_MS;
  const commandTimeout = env.P2P_COMMAND_TIMEOUT_MS;
  const guardEnabled = parseOptionalBoolean(env.P2P_NETWORK_GUARD_ENABLED, 'P2P_NETWORK_GUARD_ENABLED');
  const next: AppConfig = {
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
  validateUrl(next.jackett.baseUrl, 'JACKETT_BASE_URL');
  validateUrl(next.qbittorrent.baseUrl, 'QBITTORRENT_BASE_URL');
  return next;
}

function parseOptionalBoolean(value: string | undefined, key: string): boolean | undefined {
  if (value == null || value === '') return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new McpError('CONFIG_INVALID', `${key} must be true or false`);
}

function parseOptionalPositiveNumber(value: string | undefined, key: string): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new McpError('CONFIG_INVALID', `${key} must be a positive number`);
  return parsed;
}

function validateUrl(value: string, key: string): void {
  try { new URL(value); }
  catch { throw new McpError('CONFIG_INVALID', `${key} must be a valid URL`); }
}

function parseStringList(value: unknown, fallback: string[]): string[] {
  if (value == null) return [...fallback];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
    throw new McpError('CONFIG_INVALID', 'network_guard.guarded_operations must be a list of operation names');
  }
  return [...value];
}

function objectAt(input: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = input[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
