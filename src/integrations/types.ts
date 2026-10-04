import type { z } from 'zod';
import type { IntegrationConfig, IntegrationName } from './config.js';
import type { IntegrationHttp } from './http.js';

export interface AdapterContext { config: IntegrationConfig; http: IntegrationHttp; signal: AbortSignal }
export interface IntegrationOperation {
  service: IntegrationName;
  action: string;
  description: string;
  schema: z.ZodRawShape;
  mutation?: boolean;
  destructive?: boolean;
  guard?: 'torrent_search' | 'torrent_add' | 'torrent_pause' | 'torrent_resume' | 'torrent_delete';
  run: (context: AdapterContext, input: Record<string, unknown>) => Promise<unknown>;
}
