import { execFile } from 'node:child_process';
import { McpError } from '../shared/errors.js';
import { redactConfig } from '../shared/redact.js';

export interface NordVpnOptions {
  command: string;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandRunner = (command: string, args: string[], options: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<CommandResult>;

export interface NordVpnStatus {
  connected: boolean;
  country?: string;
  city?: string;
  server?: string;
  technology?: string;
  protocol?: string;
}

export const execFileRunner: CommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: options.timeoutMs, env: options.env }, (error, stdout, stderr) => {
      const exitCode = typeof (error as NodeJS.ErrnoException | null)?.code === 'number' ? Number((error as NodeJS.ErrnoException).code) : error ? 1 : 0;
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode });
    });
  });

export class NordVpnClient {
  constructor(private readonly options: NordVpnOptions, private readonly runner: CommandRunner = execFileRunner) {}

  async status(): Promise<NordVpnStatus> {
    const result = await this.run(statusArgs(this.options.platform));
    return parseNordVpnStatus(result.stdout || result.stderr);
  }

  async connect(country = ''): Promise<CommandResult> {
    const args = connectArgs(country, this.options.platform);
    return this.run(args);
  }

  async disconnect(): Promise<CommandResult> {
    return this.run(disconnectArgs(this.options.platform));
  }

  private async run(args: string[]): Promise<CommandResult> {
    const result = await this.runner(this.options.command, args, { timeoutMs: this.options.timeoutMs, env: commandEnvironment(process.env, this.options.platform) });
    if (result.exitCode !== 0) {
      throw new McpError('VPN_COMMAND_FAILED', 'NordVPN command failed', { exitCode: result.exitCode });
    }
    return result;
  }
}

export function connectArgs(country = '', platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'darwin') throw new McpError('VPN_UNSUPPORTED', 'The built-in NordVPN command adapter is not available on macOS.');
  if (platform === 'win32') return country ? ['-c', '--group-name', country.replaceAll('_', ' ')] : ['-c'];
  return country ? ['connect', country] : ['connect'];
}

export function disconnectArgs(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'darwin') throw new McpError('VPN_UNSUPPORTED', 'The built-in NordVPN command adapter is not available on macOS.');
  return platform === 'win32' ? ['-d'] : ['disconnect'];
}

export function statusArgs(platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'linux') throw new McpError('VPN_UNSUPPORTED', 'The built-in NordVPN status adapter requires the supported Linux CLI.');
  return ['status'];
}

export function commandEnvironment(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (platform === 'win32') {
    const root = env.SystemRoot || env.WINDIR || 'C:\\Windows';
    return {
      SystemRoot: root,
      WINDIR: root,
      COMSPEC: env.COMSPEC || `${root}\\System32\\cmd.exe`,
      PATH: `${root}\\System32;${root}`,
      PATHEXT: '.COM;.EXE;.BAT;.CMD'
    };
  }
  return { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' };
}

export function parseNordVpnStatus(output: string): NordVpnStatus {
  const fields = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]+):\s*(.*?)\s*$/);
    if (match) fields.set(match[1].toLowerCase(), match[2]);
  }
  const status = fields.get('status') ?? '';
  const connected = /^connected$/i.test(status);
  return {
    connected,
    server: fields.get('hostname') || fields.get('server'),
    country: fields.get('country'),
    city: fields.get('city'),
    technology: fields.get('current technology'),
    protocol: fields.get('current protocol')
  };
}

export function requireActiveVpn(status: Pick<NordVpnStatus, 'connected'>): void {
  if (!status.connected) {
    throw new McpError('VPN_NOT_ACTIVE', 'VPN is not connected', redactConfig(status));
  }
}
