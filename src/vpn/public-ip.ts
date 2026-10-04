import { McpError } from '../shared/errors.js';
import { isIP } from 'node:net';

export interface PublicIpResult {
  ip: string;
}

export async function getPublicIp(timeoutMs = 15000, source = 'https://api.ipify.org?format=json'): Promise<PublicIpResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(source, { signal: controller.signal });
    if (!response.ok) throw new McpError('PUBLIC_IP_FAILED', `Public IP lookup failed: HTTP ${response.status}`);
    const text = await response.text();
    let candidate: unknown = text.trim();
    try { candidate = (JSON.parse(text) as { ip?: unknown } | null)?.ip; }
    catch { /* Plain text is accepted only if it is an IP address. */ }
    const ip = typeof candidate === 'string' ? candidate.trim() : '';
    if (!isIP(ip)) throw new McpError('PUBLIC_IP_FAILED', 'Public IP lookup returned an invalid address');
    return { ip };
  } catch {
    throw new McpError('PUBLIC_IP_FAILED', 'Public IP lookup failed');
  } finally {
    clearTimeout(timeout);
  }
}
