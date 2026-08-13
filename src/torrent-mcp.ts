#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfigFromEnv } from './shared/config.js';
import { createTorrentServer } from './torrent/server.js';

try {
  const config = loadConfigFromEnv();
  const server = createTorrentServer(config);
  await server.connect(new StdioServerTransport());
} catch {
  process.stderr.write('torrent-mcp failed to start; check the local configuration\n');
  process.exitCode = 1;
}
