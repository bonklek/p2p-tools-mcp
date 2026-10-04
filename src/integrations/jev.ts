import { readFileSync, statSync } from 'node:fs';
import { McpError } from '../shared/errors.js';
import type { AppConfig } from '../shared/config.js';
import { IntegrationHttp, record } from './http.js';

export interface RankCandidate {
  id: string; title: string; size_bytes?: number; folder_name?: string; extension?: string;
  bitrate_kbps?: number; duration_seconds?: number; sample_rate_hz?: number; bit_depth?: number;
  vbr?: boolean; is_public?: boolean; free_upload_slot?: boolean; queue_length?: number;
  upload_speed_bytes_per_second?: number; preferred_source?: boolean; folder_result_count?: number;
}
export interface RankResult {
  recommendation: string | null;
  confidence: number;
  none_probability: number;
  ranked: Array<RankCandidate & { probability: number }>;
  model: string;
  note: string;
}

/** Displayed metadata and explicit preferences leave this process. IDs and usernames stay local. */
export class JevRanker {
  constructor(private readonly config: NonNullable<AppConfig['jev']>, private readonly fetchImpl: typeof fetch = fetch) {}

  async rank(query: string, candidates: RankCandidate[], preferences: string[] = []): Promise<RankResult> {
    if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
      throw new McpError('INVALID_ARGUMENT', 'Candidate IDs must be unique');
    }
    let key: string;
    try {
      if (statSync(this.config.apiKeyFile).size > 4096) throw new Error('oversize');
      key = readFileSync(this.config.apiKeyFile, 'utf8').trim();
      if (!key || /\s/.test(key)) throw new Error('invalid');
    } catch {
      throw new McpError('JEV_KEY_UNAVAILABLE', 'Configured Jev key file is unavailable');
    }
    const criteria: Record<string, string> = { none: 'No listed file is a plausible match for the requested music.' };
    candidates.forEach((candidate, index) => {
      const safe = {
        title: candidate.title.slice(0, 256),
        ...(candidate.size_bytes !== undefined ? { size_bytes: candidate.size_bytes } : {}),
        ...(candidate.folder_name ? { folder_name: candidate.folder_name.split(/[\\/]/).at(-1)?.slice(0, 128) } : {}),
        ...(candidate.extension !== undefined ? { extension: candidate.extension } : {}),
        ...(candidate.bitrate_kbps !== undefined ? { bitrate_kbps: candidate.bitrate_kbps } : {}),
        ...(candidate.duration_seconds !== undefined ? { duration_seconds: candidate.duration_seconds } : {}),
        ...(candidate.sample_rate_hz !== undefined ? { sample_rate_hz: candidate.sample_rate_hz } : {}),
        ...(candidate.bit_depth !== undefined ? { bit_depth: candidate.bit_depth } : {}),
        ...(candidate.vbr !== undefined ? { vbr: candidate.vbr } : {}),
        ...(candidate.is_public !== undefined ? { is_public: candidate.is_public } : {}),
        ...(candidate.free_upload_slot !== undefined ? { free_upload_slot: candidate.free_upload_slot } : {}),
        ...(candidate.queue_length !== undefined ? { queue_length: candidate.queue_length } : {}),
        ...(candidate.upload_speed_bytes_per_second !== undefined ? { upload_speed_bytes_per_second: candidate.upload_speed_bytes_per_second } : {}),
        ...(candidate.preferred_source !== undefined ? { preferred_source: candidate.preferred_source } : {}),
        ...(candidate.folder_result_count !== undefined ? { folder_result_count: candidate.folder_result_count } : {})
      };
      criteria[`candidate_${index}`] = JSON.stringify(safe);
    });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new McpError('JEV_TIMEOUT', 'Jev ranking timed out'));
      }, this.config.timeoutMs);
    });
    try {
      const http = new IntegrationHttp({
        enabled: true, baseUrl: 'https://api.typesafe.ai', timeoutMs: this.config.timeoutMs,
        concurrency: 1, maxResponseBytes: 65_536
      }, this.fetchImpl);
      const response = record((await Promise.race([http.request('/v1/systemone', controller.signal, {
        method: 'POST', headers: { Authorization: `Bearer ${key}` },
        body: {
          model: this.config.model,
          state: { requested_music: query, preferences },
          questions: { best_match: {
            type: 'choice',
            instructions: 'Which file is the best plausible match for requested_music and preferences? Match artist, track or album, release/version, format and quality when stated. Prefer preferred_source if otherwise comparable. Choose none if the evidence is weak. Judge metadata only; do not assume audio authenticity.',
            criteria
          } }
        }
      }), deadline])).data);
      const answer = record(record(response.answers).best_match);
      const probabilities = record(answer.probabilities);
      const expected = Object.keys(criteria);
      if (answer.type !== 'choice' || typeof answer.choice !== 'string' || !expected.includes(answer.choice)
        || typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1
        || Object.keys(probabilities).length !== expected.length || expected.some((name) => typeof probabilities[name] !== 'number' || !Number.isFinite(probabilities[name]) || Number(probabilities[name]) < 0 || Number(probabilities[name]) > 1)
        || Math.abs(expected.reduce((sum, name) => sum + Number(probabilities[name]), 0) - 1) > 0.02) {
        throw new McpError('JEV_INVALID_RESPONSE', 'Jev returned an invalid ranking');
      }
      const ranked = candidates.map((candidate, index) => ({ ...candidate, probability: Number(probabilities[`candidate_${index}`]) }))
        .sort((a, b) => b.probability - a.probability);
      const selected = answer.choice === 'none' ? null : candidates[Number(answer.choice.slice('candidate_'.length))].id;
      return {
        recommendation: selected, confidence: answer.confidence, none_probability: Number(probabilities.none), ranked,
        model: typeof response.model === 'string' ? response.model : this.config.model,
        note: 'Relative metadata ranking only. Review the selection before downloading; audio content and quality were not verified.'
      };
    } catch (error) {
      if (controller.signal.aborted) throw new McpError('JEV_TIMEOUT', 'Jev ranking timed out');
      if (error instanceof McpError) {
        if (error.code === 'INTEGRATION_AUTH_FAILED') throw new McpError('JEV_AUTH_FAILED', 'Jev rejected the configured key');
        if (error.code === 'INTEGRATION_INVALID_RESPONSE' || error.code === 'INTEGRATION_RESPONSE_TOO_LARGE') throw new McpError('JEV_INVALID_RESPONSE', 'Jev returned an invalid response');
        throw error;
      }
      throw new McpError(controller.signal.aborted ? 'JEV_TIMEOUT' : 'JEV_REQUEST_FAILED', 'Jev ranking failed');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
