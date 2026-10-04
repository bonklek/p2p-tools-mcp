import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import type { AppConfig } from './shared/config.js';
import { integrationSettings } from './integrations/config.js';
import type { ToolResult } from './shared/tool-result.js';

export const credentialPath = (env: NodeJS.ProcessEnv = process.env) => env.P2P_TOOLS_CREDENTIALS || join(homedir(), '.p2p-tools', 'credentials.json');
export function readCredentials(env: NodeJS.ProcessEnv): Record<string, string> {
  const path = credentialPath(env);
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('Credential file is unreadable'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Credential file is invalid');
  const allowed = new Set(['SLSKD_API_KEY', 'SLSKD_BASE_URL']);
  if (Object.entries(parsed).some(([k,v]) => !allowed.has(k) || typeof v !== 'string' || !v.trim())) throw new Error('Credential file is invalid');
  return parsed as Record<string,string>;
}
export async function setupStatus(config: AppConfig, handlers: Record<string, (args: unknown) => Promise<ToolResult>>) {
  const slskd = integrationSettings(config.integrations).find(s => s.name === 'slskd')!;
  const input = { provider: 'slskd', fields: ['SLSKD_API_KEY'], input_method: 'local_terminal',
    local_entry: 'p2p-tools setup credentials',
    agent_message: 'Soulseek setup needs local API access. Run p2p-tools setup credentials in a local terminal. The hidden prompt saves access locally; sensitive input is never sent through chat. Restart the MCP server afterward.',
    account_login: 'Enter your Soulseek account login in slskd configuration or its supported setup UI. If using Nicotine+, use Preferences → Network. Nicotine+ has no automation adapter in this package; use slskd for automated acquisition.' };
  const integrations=config.integrations as Record<string,{apiKey?:unknown}> | undefined;
  if (slskd.state === 'disabled' && integrations?.slskd?.apiKey) return {status:'needs_configuration',next_action:'Enable integrations.slskd in your local configuration and restart the MCP server.'};
  if (slskd.state !== 'configured') return { status: 'needs_user_input', missing_credentials: ['SLSKD_API_KEY'], user_input: input, next_action: 'Notify the user using user_input.agent_message; do not ask them to paste secrets into chat.' };
  const api = await handlers.slskd_test?.({});
  if (!api?.ok) {
    if (api && api.error.code === 'INTEGRATION_AUTH_FAILED') return {status:'needs_user_input',user_input:input,next_action:'Notify the user using user_input.agent_message; local API access was rejected.'};
    return {status:'service_unavailable',next_action:'Start slskd and check its configured URL, port, and API access. Rerun setup status before changing saved access.'};
  }
  const server = await handlers.slskd_server?.({});
  if (!server?.ok) return { status: 'server_check_failed', next_action: 'Inspect the slskd service before starting acquisition.' };
  const data = server.data as { isLoggedIn?: boolean };
  return { status: data.isLoggedIn ? 'ready' : 'needs_account_login', api_authenticated: true, soulseek_logged_in: !!data.isLoggedIn,
    ...(data.isLoggedIn ? {} : { user_input: {
      provider:'slskd',fields:['Soulseek account login'],input_method:'service_configuration',
      local_entry:'Open local slskd account configuration',
      agent_message:'Local API access works, but Soulseek is not logged in. Enter your account login in local slskd configuration, then rerun p2p-tools setup status. Keep sensitive input out of chat.',
      account_login:input.account_login
    }, next_action: 'Notify the user using user_input.agent_message. Soulseek account login and local API access are separate.' }) };
}

/** Secrets are entered only in a local TTY, never MCP arguments or shell flags. */
export async function collectCredentials(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run setup credentials in an interactive local terminal');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let baseUrl: string;
  try { baseUrl = (await rl.question('slskd URL [http://127.0.0.1:5030]: ')).trim() || 'http://127.0.0.1:5030'; } finally { rl.close(); }
  const url = new URL(baseUrl);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Enter a direct HTTP(S) service URL without embedded credentials');
  process.stdout.write('slskd API key (hidden; Enter to save, Ctrl+C to cancel): ');
  const secret = await new Promise<string>((resolve, reject) => {
    let value = '';
    const cleanup = () => { process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); };
    const onData = (data: Buffer) => {
      for (const ch of data.toString('utf8')) {
        if (ch === '\u0003') { cleanup(); reject(new Error('Credential entry cancelled')); return; }
        if (ch === '\r' || ch === '\n') { cleanup(); resolve(value); return; }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0,-1);
        else if (ch >= ' ') value += ch;
      }
    };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', onData);
  });
  if (!secret.trim()) throw new Error('No API key entered; nothing was saved');
  const path = credentialPath(env);
  mkdirSync(dirname(path), { recursive:true, mode:0o700 });
  if (!existsSync(path)) writeFileSync(path, '', { mode:0o600, flag:'wx' });
  if (process.platform === 'win32') {
    const identity = spawnSync('whoami', ['/user','/fo','csv','/nh'], { encoding:'utf8', windowsHide:true });
    const sid = identity.stdout?.match(/S-1-\d+(?:-\d+)+/)?.[0];
    if (!sid || spawnSync('icacls', [path,'/inheritance:r','/grant:r',`*${sid}:(F)`], {windowsHide:true}).status !== 0) throw new Error('Could not protect credential file permissions; no key was saved');
  } else chmodSync(path, 0o600);
  writeFileSync(path, JSON.stringify({ SLSKD_BASE_URL:baseUrl, SLSKD_API_KEY:secret }), { mode:0o600 });
  process.stdout.write('Credentials saved locally with restricted file permissions. Restart your MCP server and run p2p-tools setup status.\n');
}
