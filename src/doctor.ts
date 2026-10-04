import type { AppConfig } from './shared/config.js';
import { recoveryAction } from './shared/diagnostics.js';
import { McpError } from './shared/errors.js';
import type { TorrentDeps } from './torrent/server.js';

export interface DoctorCheck {
  name: 'configuration' | 'jackett' | 'qbittorrent' | 'network_guard' | 'traffic_isolation';
  status: 'passed' | 'warning' | 'failed' | 'not_checked';
  message: string;
  next_action?: string;
}
export interface DoctorReport {
  status: 'checks_passed' | 'attention_needed' | 'blocked';
  checks: DoctorCheck[];
}

/** Read-only probes. A successful report is not proof of traffic isolation. */
export async function createDoctorReport(config: AppConfig, deps: Pick<TorrentDeps, 'jackett' | 'qbit' | 'vpnStatusProvider'>): Promise<DoctorReport> {
  const probe = async (name: DoctorCheck['name'], run: () => Promise<DoctorCheck>): Promise<DoctorCheck> => {
    try { return await run(); }
    catch (error) {
      return { name, status: 'failed', message: 'The check could not be completed.',
        next_action: error instanceof McpError && recoveryAction(error.code) || 'Check the service configuration and local service health, then rerun doctor.' };
    }
  };
  const checks: DoctorCheck[] = [
    { name: 'configuration', status: 'passed', message: 'Configuration parsed and validated.' },
    ...await Promise.all([
      probe('jackett', async () => {
        const result = await deps.jackett.testConnection();
        if (!result.admin_api_ok) return { name: 'jackett', status: 'warning', message: 'Torznab access succeeded; configured indexers could not be verified.', next_action: recoveryAction('JACKETT_ADMIN_API_UNAVAILABLE') };
        if (!result.indexers_configured) return { name: 'jackett', status: 'warning', message: 'Jackett is reachable but has no configured indexers.', next_action: 'Configure an indexer in Jackett, then rerun doctor.' };
        return { name: 'jackett', status: 'passed', message: 'Torznab and admin API access succeeded; configured indexers were found.' };
      }),
      probe('qbittorrent', async () => {
        const result = await deps.qbit.testConnection();
        const version = result.version?.match(/^v?([45])\.\d+\.\d+(?:\.\d+)?$/);
        return version
          ? { name: 'qbittorrent', status: 'passed', message: `Web UI access succeeded; recognized qBittorrent ${version[1]}.x API family.` }
          : { name: 'qbittorrent', status: 'warning', message: 'Web UI access succeeded; the version is not a recognized stable 4.x or 5.x release.', next_action: 'Check the installed qBittorrent version against the documented API support.' };
      }),
      probe('network_guard', async () => {
        if (!config.networkGuard.enabled || !config.networkGuard.guardedOperations.length) return {
          name: 'network_guard', status: 'warning', message: 'No operations are protected by the host VPN guard.',
          next_action: 'Verify the external VPN boundary or configure the host guard for the intended operations.'
        };
        // Match actual guard behavior: even requireVpnConnected=false still reads status.
        const status = await deps.vpnStatusProvider();
        if (!config.networkGuard.requireVpnConnected) return { name: 'network_guard', status: 'warning', message: 'VPN status is readable, but the guard permits a disconnected VPN.', next_action: 'Review whether the intended operations should require a connected VPN.' };
        return status.connected
          ? { name: 'network_guard', status: 'passed', message: 'Host VPN reports connected; the configured guarded operations can proceed.' }
          : { name: 'network_guard', status: 'failed', message: 'Host VPN reports disconnected; guarded operations are blocked.', next_action: recoveryAction('VPN_NOT_ACTIVE') };
      })
    ]),
    { name: 'traffic_isolation', status: 'not_checked', message: 'Traffic routing, kill-switch behavior, and container isolation were not verified.', next_action: 'Verify the deployment boundary separately using the deployment guide.' }
  ];
  return { status: checks.some((check) => check.status === 'failed') ? 'blocked' : checks.some((check) => check.status === 'warning') ? 'attention_needed' : 'checks_passed', checks };
}
