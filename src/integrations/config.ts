import { z } from 'zod';

export const integrationNames = ['slskd', 'prowlarr', 'gluetun', 'cross_seed', 'transmission', 'syncthing', 'ipfs'] as const;
export type IntegrationName = typeof integrationNames[number];
const ports: Record<IntegrationName, number> = { slskd: 5030, prowlarr: 9696, gluetun: 8000, cross_seed: 2468, transmission: 9091, syncthing: 8384, ipfs: 5001 };
const schema = z.strictObject({
  enabled: z.literal(true), baseUrl: z.string(), apiKey: z.string().min(1).optional(),
  username: z.string().min(1).optional(), password: z.string().min(1).optional(),
  rpcPath: z.string().regex(/^\/(?:[A-Za-z0-9_.~-]+\/)*[A-Za-z0-9_.~-]+$/).optional(),
  timeoutMs: z.number().int().min(1).max(120_000).default(15_000),
  concurrency: z.number().int().min(1).max(8).default(2),
  maxResponseBytes: z.number().int().min(1024).max(8_388_608).default(1_048_576)
});
export type IntegrationConfig = z.infer<typeof schema>;
export type IntegrationSetting = { name: IntegrationName } & (
  { state: 'disabled' | 'misconfigured' } | { state: 'configured'; config: IntegrationConfig }
);

export function integrationSettings(raw: unknown): IntegrationSetting[] {
  const rootValid = raw === undefined || (!!raw && typeof raw === 'object' && !Array.isArray(raw));
  const entries = (rootValid && raw || {}) as Record<string, unknown>;
  return integrationNames.map((name): IntegrationSetting => {
    if (!rootValid) return { name, state: 'misconfigured' };
    const value = entries[name];
    if (value === undefined) return { name, state: 'disabled' };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { name, state: 'misconfigured' };
    const input = value as Record<string, unknown>;
    if (input.enabled === false || input.enabled === undefined) return { name, state: 'disabled' };
    const parsed = schema.safeParse({ baseUrl: `http://127.0.0.1:${ports[name]}`, ...input });
    if (!parsed.success) return { name, state: 'misconfigured' };
    const config = parsed.data;
    try {
      const url = new URL(config.baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error();
      if (!['transmission', 'ipfs'].includes(name) && !config.apiKey) throw Error();
      if (Boolean(config.username) !== Boolean(config.password)) throw Error();
      // Do not accept credentials which this adapter would silently ignore.
      if (name !== 'transmission' && (config.username || config.password)) throw Error();
      if (name === 'transmission' && config.apiKey) throw Error();
      if (name !== 'transmission' && config.rpcPath !== undefined) throw Error();
    } catch { return { name, state: 'misconfigured' }; }
    return { name, state: 'configured', config };
  });
}

export function unknownIntegrations(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw)
    && Object.keys(raw).some((key) => !integrationNames.includes(key as IntegrationName));
}
