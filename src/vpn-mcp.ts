#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfigFromEnv } from './shared/config.js';
import { createVpnServer } from './vpn/server.js';

try {
  const config = loadConfigFromEnv();
  const server = createVpnServer(config);
  await server.connect(new StdioServerTransport());
} catch {
  process.stderr.write('vpn-mcp failed to start; check the local configuration\n');
  process.exitCode = 1;
}
