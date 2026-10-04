import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import YAML from 'yaml';
const runtime=resolve(process.argv[2]||'.');
const temp=mkdtempSync(join(tmpdir(),'p2p-phone-smoke-'));
const env={...process.env,P2P_ANDROID_CONFIG:join(temp,'unpaired.json'),HERMES_HOME:temp};
const client=new Client({name:'android-package-check',version:'1.0.0'});
try {
  const transport=new StdioClientTransport({command:process.execPath,args:[join(runtime,'dist/android-mcp.js')],env,stderr:'pipe'});
  await client.connect(transport);
  const listed=await client.listTools();assert.equal(listed.tools.length,9);
  const status=await client.callTool({name:'p2p_setup_status',arguments:{}});
  assert.equal(status.structuredContent.ok,true);assert.equal(status.structuredContent.data.status,'needs_user_input');
  const invalid=await client.callTool({name:'p2p_music_cancel',arguments:{job_id:'../../etc'}});assert.equal(invalid.isError,true);
  writeFileSync(join(temp,'config.yaml'),'# Keep this comment\nmodel: existing-model\nmcp_servers:\n  existing:\n    command: keep-me\n');
  execFileSync(process.execPath,[join(runtime,'dist/android-cli.js'),'register-hermes'],{env});
  const registered=readFileSync(join(temp,'config.yaml'),'utf8');const doc=YAML.parse(registered);
  assert.match(registered,/Keep this comment/);assert.equal(doc.model,'existing-model');assert.equal(doc.mcp_servers.existing.command,'keep-me');
  assert.equal(doc.mcp_servers.p2p_android.env.P2P_ANDROID_CONFIG,env.P2P_ANDROID_CONFIG);
  assert.equal(doc.mcp_servers.p2p_android.args[0],join(runtime,'dist/android-mcp.js'));
  assert.match(readFileSync(join(temp,'config.yaml.p2p-backup'),'utf8'),/existing-model/);
  console.log('Packaged MCP: nine tools, local setup action, invalid-input rejection, and non-destructive Hermes registration passed');
} finally {await client.close();rmSync(temp,{recursive:true,force:true});}
