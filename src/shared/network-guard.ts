import type { AppConfig } from './config.js';

export interface VpnStatusLike {
  connected: boolean;
  country?: string;
  city?: string;
  server?: string;
}

export interface NetworkGuardResult {
  allowed: boolean;
  reason: 'network_guard_disabled' | 'operation_not_guarded' | 'vpn_connected' | 'vpn_not_connected' | 'vpn_requirement_disabled' | 'status_provider_error';
  operation?: string;
  status?: VpnStatusLike;
  error?: string;
}

export type VpnStatusProvider = () => Promise<VpnStatusLike>;

export async function checkNetworkGuard(config: AppConfig, statusProvider: VpnStatusProvider, operation?: string): Promise<NetworkGuardResult> {
  if (!config.networkGuard.enabled) {
    return { allowed: true, reason: 'network_guard_disabled', operation };
  }

  if (operation && !config.networkGuard.guardedOperations.includes(operation)) {
    return { allowed: true, reason: 'operation_not_guarded', operation };
  }

  try {
    const status = await statusProvider();
    if (config.networkGuard.requireVpnConnected && !status.connected) {
      return { allowed: false, reason: 'vpn_not_connected', operation, status };
    }
    return { allowed: true, reason: status.connected ? 'vpn_connected' : 'vpn_requirement_disabled', operation, status };
  } catch {
    return { allowed: false, reason: 'status_provider_error', operation };
  }
}
