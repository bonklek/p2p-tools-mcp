import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { ToolResult } from '../shared/tool-result.js';
import { slskdFiltersSchema, validateSlskdFilters } from '../integrations/slskd-filters.js';

const trackSchema = z.strictObject({
  id: z.string().trim().min(1).max(128), query: z.string().trim().min(1).max(512),
  artist: z.string().min(1).optional(), title: z.string().min(1).optional(), album: z.string().optional(), duration_ms: z.number().int().nonnegative().optional(),
  filters: slskdFiltersSchema.optional(),
  preferences: z.array(z.string().trim().min(1).max(128)).max(15).optional()
});
const manifestSchema = z.strictObject({
  version: z.literal(1), tracks: z.array(trackSchema).min(1).max(10_000),
  filters: slskdFiltersSchema.optional(),
  preferences: z.array(z.string().trim().min(1).max(128)).max(15).optional(),
  preferred_users: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
  search_limit: z.number().int().min(1).max(100).default(100),
  jev_call_budget: z.number().int().min(0).max(10_000).default(100),
  auto_select_jev: z.boolean().default(false),
  jev_min_probability: z.number().min(0).max(1).default(0.9),
  jev_min_margin: z.number().min(0).max(1).default(0.5)
});
type Manifest = z.infer<typeof manifestSchema>;
type Handler = (args: unknown) => Promise<ToolResult>;
export interface BulkHandlers { slskd_search?: Handler; slskd_results?: Handler; slskd_download?: Handler; slskd_batch?: Handler; slskd_rank?: Handler }
export interface BulkOptions { manifestPath: string; statePath: string; approvalsPath?: string; plan?: boolean; download?: boolean; retryErrors?: boolean; maxItems?: number; downloadBudgetBytes?: number; pollMs?: number; maxPolls?: number; recoveryMs?: number; onProgress?: (processed: number, total: number) => void }
interface FileResult { file_id: string; username: string; title: string; folder_name?: string; size: number; is_public: boolean }
type ReviewCandidate = Pick<FileResult, 'file_id' | 'username' | 'title' | 'folder_name' | 'size'> & { jev_probability?: number };
interface ItemState {
  status: 'pending' | 'selected' | 'review' | 'not_found' | 'error' | 'download_intent' | 'queued';
  search_id?: string; file_id?: string; username?: string; title?: string; source?: 'exact' | 'jev' | 'approved';
  batch_id?: string; reason?: string;
  size?: number;
  search_submitted?: boolean; search_restarts?: number;
  review_candidates?: ReviewCandidate[];
  jev_recommendation?: string | null; jev_confidence?: number; none_probability?: number;
}
interface State { version: 1; manifest_sha256: string; jev_calls: number; items: Record<string, ItemState> }
const approvalsSchema = z.strictObject({ version: z.literal(1), choices: z.array(z.strictObject({ id: z.string().min(1), file_id: z.string().regex(/^[a-f0-9]{64}$/) })).max(10_000) });

function readManifest(path: string): { manifest: Manifest; digest: string } {
  const raw = readFileSync(path, 'utf8');
  const parsed = manifestSchema.parse(JSON.parse(raw));
  if (new Set(parsed.tracks.map((track) => track.id)).size !== parsed.tracks.length) throw new Error('Track IDs must be unique');
  validateSlskdFilters(parsed.filters);
  for (const track of parsed.tracks) validateSlskdFilters(track.filters);
  return { manifest: parsed, digest: createHash('sha256').update(JSON.stringify(parsed)).digest('hex') };
}
function saveState(path: string, state: State): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
  renameSync(temp, path);
}
function data<T>(result: ToolResult, action: string): T {
  if (!result.ok) throw new Error(`${action}: ${result.error.code}`);
  return result.data as T;
}
function words(value: string): string[] { return value.toLocaleLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean); }
function clearMatch(query: string, file: FileResult): boolean {
  const queryWords = words(query);
  const querySet = new Set(queryWords);
  const titleWords = words(file.title.replace(/\.[^.]+$/, ''));
  const fileWords = new Set([...words(file.folder_name ?? ''), ...titleWords]);
  return queryWords.length > 0 && queryWords.every((word) => fileWords.has(word))
    && titleWords.every((word) => querySet.has(word) || /^\d{1,3}$/.test(word));
}
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const transient = (result: ToolResult) => !result.ok && ['INTEGRATION_TIMEOUT', 'INTEGRATION_REQUEST_FAILED', 'INTEGRATION_BUSY', 'NETWORK_GUARD_BLOCKED', 'INTEGRATION_UNAVAILABLE'].includes(result.error.code);
function safeReason(error: unknown): string {
  const value = error instanceof Error ? error.message : '';
  return /^(search|results|rank): [A-Z_]+$/.test(value) ? value : 'operation_failed';
}

export async function runSlskdBulk(options: BulkOptions, handlers: BulkHandlers): Promise<Record<string, unknown>> {
  const manifestPath = resolve(options.manifestPath);
  const statePath = resolve(options.statePath);
  if (manifestPath === statePath) throw new Error('Manifest and state paths must differ');
  const { manifest, digest } = readManifest(manifestPath);
  const approvals = options.approvalsPath ? approvalsSchema.parse(JSON.parse(readFileSync(resolve(options.approvalsPath), 'utf8'))) : undefined;
  if (approvals && new Set(approvals.choices.map((choice) => choice.id)).size !== approvals.choices.length) throw new Error('Approval IDs must be unique');
  const approved = new Map(approvals?.choices.map((choice) => [choice.id, choice.file_id]) ?? []);
  if ([...approved.keys()].some((id) => !manifest.tracks.some((track) => track.id === id))) throw new Error('Approval contains an unknown track ID');
  if (manifest.tracks.some((track) => (manifest.preferences?.length ?? 0) + (track.preferences?.length ?? 0) > 15)) throw new Error('Combined preferences cannot exceed 15 per track');
  if (options.plan) return { mode: 'plan', tracks: manifest.tracks.length, search_limit: manifest.search_limit, jev_call_budget: manifest.jev_call_budget, auto_select_jev: manifest.auto_select_jev, download_requested: Boolean(options.download), state_path: statePath };
  if (!handlers.slskd_search || !handlers.slskd_results) throw new Error('slskd search and results must be configured');
  if (options.download && (!handlers.slskd_download || !handlers.slskd_batch)) throw new Error('slskd download and batch inspection must be configured');
  if (manifest.auto_select_jev && !handlers.slskd_rank) throw new Error('Jev must be configured for auto_select_jev');
  const lockPath = `${statePath}.lock`;
  let lock: number;
  try { lock = openSync(lockPath, 'wx', 0o600); }
  catch {
    let stale = false;
    try {
      const pid = Number(readFileSync(lockPath, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); }
        catch (error) { stale = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      }
      if (stale) unlinkSync(lockPath);
    } catch { /* Keep an unknown lock rather than risk concurrent writes. */ }
    if (!stale) throw new Error('Batch state is locked by another run');
    try { lock = openSync(lockPath, 'wx', 0o600); }
    catch { throw new Error('Batch state is locked by another run'); }
  }
  try {
    writeFileSync(lock, String(process.pid));
    let state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) as State : { version: 1, manifest_sha256: digest, jev_calls: 0, items: {} };
    if (state.version !== 1 || state.manifest_sha256 !== digest || !Number.isSafeInteger(state.jev_calls) || state.jev_calls < 0 || !state.items || typeof state.items !== 'object') throw new Error('State does not match this manifest');
    if (!existsSync(statePath)) saveState(statePath, state);
    const reconcileIntent = async (id: string, intent: ItemState): Promise<void> => {
      let emptyReads = 0;
      while (true) {
        const response = await handlers.slskd_batch!({ batch_id: intent.batch_id });
        if (transient(response)) { await wait(options.recoveryMs ?? 15_000); continue; }
        const batch = response.ok ? response.data as { id?: string; transfers?: unknown[] } : undefined;
        if ((!response.ok && response.error.code === 'INTEGRATION_NOT_FOUND') || (batch?.id === intent.batch_id && Array.isArray(batch?.transfers) && !batch.transfers.length)) {
          emptyReads++;
          if (emptyReads < 3) { await wait(options.recoveryMs ?? 2000); continue; }
        }
        const item: ItemState = batch?.id === intent.batch_id && Array.isArray(batch?.transfers) && batch.transfers.length
          ? { ...intent, status: 'queued', reason: undefined }
          : { ...intent, status: 'review', reason: 'download_outcome_uncertain' };
        state.items[id] = item; saveState(statePath, state);
        return;
      }
    };
    const enqueue = async (id: string, selected: ItemState): Promise<void> => {
      if (options.downloadBudgetBytes !== undefined) {
        if (selected.size === undefined || selected.size > options.downloadBudgetBytes) {
          state.items[id] = { ...selected, reason: 'storage_budget_deferred' }; saveState(statePath,state); return;
        }
        options.downloadBudgetBytes -= selected.size;
      }
      while (true) {
        const batchId = randomUUID();
        let item: ItemState = { ...selected, status: 'download_intent', batch_id: batchId };
        // The intent is durable before the network mutation, so uncertain outcomes are inspected on resume.
        state.items[id] = item; saveState(statePath, state);
        const response = await handlers.slskd_download!({ search_id: item.search_id, username: item.username, file_ids: [item.file_id], batch_id: batchId });
        if (!response.ok && ['NETWORK_GUARD_BLOCKED', 'INTEGRATION_BUSY'].includes(response.error.code)) {
          state.items[id] = { ...selected, reason: 'waiting_for_service' }; saveState(statePath, state);
          await wait(options.recoveryMs ?? 15_000); continue;
        }
        if (!response.ok && transient(response)) { await reconcileIntent(id, item); return; }
        if (response.ok) {
          const outcome = (response.data as { outcome?: string }).outcome;
          item = { ...item, status: outcome === 'accepted' ? 'queued' : 'review', reason: outcome === 'accepted' ? undefined : 'download_not_accepted' };
        } else item = { ...item, status: 'review', reason: `download: ${response.error.code}` };
        state.items[id] = item; saveState(statePath, state);
        return;
      }
    };
    let processed = 0;
    const markProcessed = () => { processed++; if (processed % 25 === 0) options.onProgress?.(processed, manifest.tracks.length); };
    let consecutiveErrors = 0;
    let stoppedReason: string | undefined;
    for (const track of manifest.tracks) {
      if (processed >= (options.maxItems ?? manifest.tracks.length)) break;
      let item: ItemState | undefined = state.items[track.id];
      const approvedFileId = approved.get(track.id);
      if (approvedFileId && item?.status === 'review') {
        const chosen = item.review_candidates?.find((candidate) => candidate.file_id === approvedFileId);
        if (!chosen) throw new Error(`Approval for ${track.id} is not a saved public candidate`);
        item = { status: 'selected', search_id: item.search_id, file_id: chosen.file_id, username: chosen.username, title: chosen.title, size: chosen.size, source: 'approved' };
        state.items[track.id] = item; saveState(statePath, state);
      }
      if (item?.status === 'error' && options.retryErrors) {
        item = item.search_id ? { status: 'pending', search_id: item.search_id } : undefined;
        if (item) state.items[track.id] = item;
        else delete state.items[track.id];
        saveState(statePath, state);
      }
      if (item?.status === 'download_intent') {
        // An interrupted mutation is reconciled by ID; it is never submitted again blindly.
        await reconcileIntent(track.id, item); markProcessed(); continue;
      }
      if (item?.status === 'selected' && options.download) {
        await enqueue(track.id, item); markProcessed(); continue;
      }
      if (item && item.status !== 'pending') continue;
      markProcessed();
      try {
        if (!item) {
          item = { status: 'pending', search_id: randomUUID(), search_submitted: false, search_restarts: 0 };
          state.items[track.id] = item; saveState(statePath, state);
          const submitStarted = Date.now();
          const submitted = await handlers.slskd_search({ query: track.query, limit: manifest.search_limit, search_id: item.search_id });
          if (submitted.ok) {
            item = Date.now() - submitStarted > 30_000
              ? { status: 'pending', search_id: randomUUID(), search_submitted: false, search_restarts: 1 }
              : { ...item, search_submitted: true };
            state.items[track.id] = item; saveState(statePath, state);
          }
          else if (transient(submitted)) await wait(options.recoveryMs ?? 15_000);
          else throw new Error(`search: ${submitted.error.code}`);
        }
        let result: { isComplete?: boolean; files: FileResult[]; total_matches: number; truncated?: boolean } | undefined;
        let polls = 0;
        while (true) {
          const requestStarted = Date.now();
          const found = await handlers.slskd_results({ search_id: item.search_id, limit: 100, filters: track.filters ?? manifest.filters });
          if (!found.ok && found.error.code === 'INTEGRATION_NOT_FOUND') {
            if (item.search_submitted) {
              if ((item.search_restarts ?? 0) >= 2) { item = { ...item, status: 'review', reason: 'search_expired_repeatedly' }; break; }
              item = { status: 'pending', search_id: randomUUID(), search_submitted: false, search_restarts: (item.search_restarts ?? 0) + 1 };
              state.items[track.id] = item; saveState(statePath, state);
            }
            const submitStarted = Date.now();
            const submitted = await handlers.slskd_search({ query: track.query, limit: manifest.search_limit, search_id: item.search_id });
            if (submitted.ok) {
              if (Date.now() - submitStarted > 30_000 && (item.search_restarts ?? 0) >= 2) { item = { ...item, status: 'review', reason: 'sleep_interrupted_repeatedly' }; break; }
              item = Date.now() - submitStarted > 30_000 && (item.search_restarts ?? 0) < 2
                ? { status: 'pending', search_id: randomUUID(), search_submitted: false, search_restarts: (item.search_restarts ?? 0) + 1 }
                : { ...item, search_submitted: true };
              state.items[track.id] = item; saveState(statePath, state);
              polls = 0;
            } else if (!transient(submitted)) throw new Error(`search: ${submitted.error.code}`);
            else await wait(options.recoveryMs ?? 15_000);
            continue;
          }
          if (transient(found)) { item = { ...item, reason: 'waiting_for_service' }; state.items[track.id] = item; saveState(statePath, state); await wait(options.recoveryMs ?? 15_000); continue; }
          const polled = data<{ isComplete?: boolean; files: FileResult[]; total_matches: number; truncated?: boolean }>(found, 'results');
          if (!item.search_submitted || item.reason) { item = { ...item, search_submitted: true, reason: undefined }; state.items[track.id] = item; saveState(statePath, state); }
          if (Date.now() - requestStarted > 30_000) {
            if ((item.search_restarts ?? 0) >= 2) { item = { ...item, status: 'review', reason: 'sleep_interrupted_repeatedly' }; break; }
            item = { status: 'pending', search_id: randomUUID(), search_submitted: false, search_restarts: (item.search_restarts ?? 0) + 1 };
            state.items[track.id] = item; saveState(statePath, state);
            polls = 0; continue;
          }
          if (polled.isComplete === true) { result = polled; break; }
          polls++;
          if (polls >= (options.maxPolls ?? 8)) { item = { ...item, status: 'review', reason: 'search_incomplete' }; break; }
          const waitStarted = Date.now();
          await wait(options.pollMs ?? 5000);
          if (Date.now() - waitStarted > (options.pollMs ?? 5000) + 30_000) {
            if ((item.search_restarts ?? 0) >= 2) { item = { ...item, status: 'review', reason: 'sleep_interrupted_repeatedly' }; break; }
            item = { status: 'pending', search_id: randomUUID(), search_submitted: false, search_restarts: (item.search_restarts ?? 0) + 1 };
            state.items[track.id] = item; saveState(statePath, state);
            polls = 0;
          }
        }
        if (!result || result.isComplete !== true) { state.items[track.id] = item; saveState(statePath, state); continue; }
        const candidates = result.files.filter((file) => file.is_public);
        let ranking: { recommendation: string | null; confidence: number; none_probability: number; ranked: Array<{ file_id: string; probability: number }> } | undefined;
        if (!candidates.length) item = { ...item, status: 'not_found', reason: 'no_public_match' };
        else if (result.truncated || result.total_matches > 100 || candidates.length > 25) item = { ...item, status: 'review', reason: 'too_many_candidates' };
        else if (candidates.length === 1 && !(manifest.preferences?.length || track.preferences?.length) && clearMatch(track.query, candidates[0])) {
          const chosen = candidates[0];
          item = { ...item, status: 'selected', file_id: chosen.file_id, username: chosen.username, title: chosen.title, size: chosen.size, source: 'exact' };
        } else if (!handlers.slskd_rank) item = { ...item, status: 'review', reason: 'jev_unavailable' };
        else if (state.jev_calls >= manifest.jev_call_budget) item = { ...item, status: 'review', reason: 'jev_budget_exhausted' };
        else {
          state.jev_calls++;
          item = { ...item, status: 'review', reason: 'jev_outcome_uncertain', review_candidates: candidates.slice(0, 25).map(({ file_id, username, title, folder_name, size }) => ({ file_id, username, title, folder_name, size })) };
          state.items[track.id] = item; saveState(statePath, state);
          const rankedData = data<{ recommendation: string | null; confidence: number; none_probability: number; ranked: Array<{ file_id: string; probability: number }> }>(await handlers.slskd_rank({
            search_id: item.search_id, query: track.query, limit: 25,
            filters: { ...(track.filters ?? manifest.filters), public_only: true },
            preferences: [...(manifest.preferences ?? []), ...(track.preferences ?? [])], preferred_users: manifest.preferred_users
          }), 'rank');
          ranking = rankedData;
          const best = rankedData.ranked.find((candidate) => candidate.file_id === rankedData.recommendation);
          const second = Math.max(rankedData.none_probability, ...rankedData.ranked.filter((candidate) => candidate.file_id !== rankedData.recommendation).map((candidate) => candidate.probability));
          const chosen = candidates.find((candidate) => candidate.file_id === rankedData.recommendation);
          if (chosen && best && manifest.auto_select_jev && rankedData.confidence >= manifest.jev_min_probability && best.probability >= manifest.jev_min_probability && best.probability - second >= manifest.jev_min_margin) {
            item = { ...item, status: 'selected', file_id: chosen.file_id, username: chosen.username, title: chosen.title, size: chosen.size, source: 'jev', jev_recommendation: rankedData.recommendation, jev_confidence: rankedData.confidence, none_probability: rankedData.none_probability };
          } else item = { ...item, status: 'review', reason: 'jev_needs_review' };
        }
        if (item.status === 'review') {
          const probabilities = new Map(ranking?.ranked.map(({ file_id, probability }) => [file_id, probability]) ?? []);
          item.review_candidates = candidates.slice(0, 25).map(({ file_id, username, title, folder_name, size }) => ({ file_id, username, title, folder_name, size, ...(probabilities.has(file_id) ? { jev_probability: probabilities.get(file_id) } : {}) }))
            .sort((a, b) => (b.jev_probability ?? 0) - (a.jev_probability ?? 0));
          if (ranking) { item.jev_recommendation = ranking.recommendation; item.jev_confidence = ranking.confidence; item.none_probability = ranking.none_probability; }
        }
      } catch (error) {
        const reason = safeReason(error);
        item = item?.reason === 'jev_outcome_uncertain' && reason.startsWith('rank:')
          ? { ...item, status: 'review', reason: 'jev_outcome_uncertain' }
          : { ...item, status: 'error', reason };
      }
      state.items[track.id] = item; saveState(statePath, state);
      if (item.status === 'selected' && options.download) await enqueue(track.id, item);
      consecutiveErrors = item.status === 'error' ? consecutiveErrors + 1 : 0;
      if (consecutiveErrors >= 3) { stoppedReason = 'three_consecutive_errors'; break; }
    }
    const counts: Record<string, number> = { pending: 0, selected: 0, review: 0, not_found: 0, error: 0, download_intent: 0, queued: 0, unprocessed: 0 };
    for (const track of manifest.tracks) counts[state.items[track.id]?.status ?? 'unprocessed']++;
    const attention = manifest.tracks.filter((track) => ['review', 'not_found', 'error', 'download_intent'].includes(state.items[track.id]?.status ?? '')).slice(0, 10).map((track) => ({ id: track.id, reason: state.items[track.id].reason }));
    return { mode: options.download ? 'download' : 'select', total: manifest.tracks.length, jev_calls: state.jev_calls, jev_call_budget: manifest.jev_call_budget, counts, attention, more_attention: Math.max(0, counts.review + counts.not_found + counts.error + counts.download_intent - attention.length), ...(stoppedReason ? { stopped_reason: stoppedReason } : {}), state_path: statePath };
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}
