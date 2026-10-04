#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { androidHandlers,androidToolSpecs } from './android/backend.js';
import { mcpJsonContent } from './shared/tool-result.js';
const server=new McpServer({name:'p2p-tools-android',version:'0.3.0-alpha.1'});
const handlers=androidHandlers();
for(const [name,spec] of Object.entries(androidToolSpecs))server.registerTool(name,{...spec,inputSchema:z.strictObject(spec.inputSchema)},async args=>mcpJsonContent(await handlers[name](args)));
await server.connect(new StdioServerTransport());
