import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppConfig } from '../shared/config.js';
import { mcpJsonContent, structuredResult, type ToolResult } from '../shared/tool-result.js';
import { PACKAGE_VERSION } from '../shared/version.js';
import { NordVpnClient, requireActiveVpn } from './nordvpn.js';
import { getPublicIp } from './public-ip.js';

export type VpnToolHandler = (args: unknown) => Promise<ToolResult>;

async function structured(run: () => Promise<unknown>): Promise<ToolResult> {
  return structuredResult(run, publicErrorMessage);
}

function publicErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    VPN_COMMAND_FAILED: 'VPN command failed',
    VPN_NOT_ACTIVE: 'VPN is not connected',
    VPN_UNSUPPORTED: 'VPN command automation is not supported on this operating system',
    PUBLIC_IP_FAILED: 'Public IP lookup failed'
  };
  return messages[code] ?? 'The tool operation failed';
}

export function createVpnToolHandlers(
  config: AppConfig,
  client = new NordVpnClient({ command: config.vpn.command, timeoutMs: config.timeouts.commandMs })
): Record<string, VpnToolHandler> {
  const handlers: Record<string, VpnToolHandler> = {
    vpn_status: () => structured(() => client.status()),
    vpn_connect: (args: unknown) => {
      const country = typeof args === 'object' && args && 'country' in args && typeof (args as { country?: unknown }).country === 'string'
        ? (args as { country: string }).country
        : config.vpn.defaultCountry;
      return structured(async () => {
        await client.connect(country);
        return { connected: true };
      });
    },
    vpn_disconnect: () => structured(async () => {
      await client.disconnect();
      return { connected: false };
    }),
    vpn_public_ip: () => structured(() => getPublicIp(config.timeouts.httpMs)),
    vpn_require_active: () => structured(async () => {
      const status = await client.status();
      requireActiveVpn(status);
      return { ok: true, status };
    })
  };

  return Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, async (args: unknown) => {
    const parsed = z.object(vpnToolSpecs[name].inputSchema).safeParse(args ?? {});
    if (!parsed.success) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Invalid tool argument' } };
    return handler(parsed.data);
  }]));
}

const vpnToolSpecs: Record<string, {
  description: string;
  inputSchema: z.ZodRawShape;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
}> = {
  vpn_status: { description: 'Return NordVPN connection status', inputSchema: {}, annotations: { readOnlyHint: true } },
  vpn_connect: { description: 'Connect NordVPN. Optional argument: country.', inputSchema: { country: z.string().min(1).optional() } },
  vpn_disconnect: { description: 'Disconnect NordVPN', inputSchema: {}, annotations: { destructiveHint: true, idempotentHint: true } },
  vpn_public_ip: { description: 'Return current public IP address', inputSchema: {}, annotations: { readOnlyHint: true } },
  vpn_require_active: { description: 'Fail unless NordVPN is connected', inputSchema: {}, annotations: { readOnlyHint: true } }
};

export function createVpnServer(config: AppConfig, client = new NordVpnClient({ command: config.vpn.command, timeoutMs: config.timeouts.commandMs })): McpServer {
  const server = new McpServer({ name: 'vpn-mcp', version: PACKAGE_VERSION });
  const handlers = createVpnToolHandlers(config, client);

  for (const [name, spec] of Object.entries(vpnToolSpecs)) {
    server.registerTool(name, spec, async (args: unknown) => mcpJsonContent(await handlers[name](args)));
  }

  return server;
}
