import { McpError } from '../shared/errors.js';

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
    try {
      const json = JSON.parse(text) as { ip?: string };
      if (json.ip) return { ip: json.ip };
    } catch {
      // fall back to plain-text response
    }
    const ip = text.trim();
    if (!ip) throw new McpError('PUBLIC_IP_FAILED', 'Public IP lookup returned empty response');
    return { ip };
  } finally {
    clearTimeout(timeout);
  }
}
