import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSlskdBulk, type BulkHandlers } from './slskd-bulk.js';

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(manifest: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), 'p2p-bulk-'));
  directories.push(directory);
  const manifestPath = join(directory, 'songs.json');
  const statePath = join(directory, 'state.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { manifestPath, statePath };
}
const file = { file_id: 'a'.repeat(64), username: 'peer', title: 'Artist - Song.flac', folder_name: 'Album', size: 20_000_000, is_public: true };
const base = { version: 1, tracks: [{ id: 'track-1', query: 'Artist Song' }] };
function handlers(files = [file]): BulkHandlers {
  return {
    slskd_search: vi.fn(async () => ({ ok: true as const, data: { search_id: 'ec435694-5c7d-11f1-9cf0-189341ab14ee' } })),
    slskd_results: vi.fn(async () => ({ ok: true as const, data: { isComplete: true, files, total_matches: files.length, truncated: false } })),
    slskd_download: vi.fn(async () => ({ ok: true as const, data: { outcome: 'accepted' } })),
    slskd_batch: vi.fn(async () => ({ ok: true as const, data: { id: 'unused', transfers: [] } })),
    slskd_rank: vi.fn(async () => ({ ok: true as const, data: { recommendation: file.file_id, confidence: 0.95, none_probability: 0.01, ranked: [{ file_id: file.file_id, probability: 0.95 }] } }))
  };
}

describe('resumable Soulseek bulk flow', () => {
  it('holds a selection above the remaining storage budget without a download mutation',async()=>{
    const paths=fixture(base);const services=handlers();
    expect(await runSlskdBulk({...paths,download:true,downloadBudgetBytes:file.size-1},services)).toMatchObject({counts:{selected:1,queued:0}});
    expect(services.slskd_download).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(paths.statePath,'utf8')).items['track-1']).toMatchObject({size:file.size,reason:'storage_budget_deferred'});
    expect(await runSlskdBulk({...paths,download:true,downloadBudgetBytes:file.size},services)).toMatchObject({counts:{queued:1}});
    expect(services.slskd_download).toHaveBeenCalledTimes(1);
  });
  it('plans without service access or state writes', async () => {
    const paths = fixture(base);
    const result = await runSlskdBulk({ ...paths, plan: true }, {});
    expect(result).toMatchObject({ mode: 'plan', tracks: 1, auto_select_jev: false });
  });

  it('selects an exact public match without Jev and queues it only with explicit download', async () => {
    const paths = fixture(base);
    const services = handlers();
    expect(await runSlskdBulk(paths, services)).toMatchObject({ counts: { selected: 1, queued: 0 } });
    expect(services.slskd_rank).not.toHaveBeenCalled();
    expect(services.slskd_download).not.toHaveBeenCalled();
    expect(await runSlskdBulk({ ...paths, download: true }, services)).toMatchObject({ counts: { selected: 0, queued: 1 } });
    expect(services.slskd_download).toHaveBeenCalledTimes(1);
    await runSlskdBulk({ ...paths, download: true }, services);
    expect(services.slskd_download).toHaveBeenCalledTimes(1);
  });

  it('sends ambiguous shortlists to Jev and defaults to review', async () => {
    const paths = fixture({ ...base, preferences: ['Prefer studio'], tracks: [{ id: 'track-1', query: 'Artist Song', filters: { file_types: ['audio'] } }] });
    const services = handlers([file, { ...file, file_id: 'b'.repeat(64), title: 'Artist Song live.mp3' }]);
    expect(await runSlskdBulk(paths, services)).toMatchObject({ counts: { review: 1 }, attention: [{ id: 'track-1', reason: 'jev_needs_review' }] });
    expect(services.slskd_rank).toHaveBeenCalledWith(expect.objectContaining({ preferences: ['Prefer studio'], filters: { file_types: ['audio'], public_only: true } }));
    expect(services.slskd_download).not.toHaveBeenCalled();
  });

  it('does not treat an unrequested live version as an exact match', async () => {
    const paths = fixture(base);
    const services = handlers([{ ...file, title: 'Artist Song live.flac' }]);
    expect(await runSlskdBulk(paths, services)).toMatchObject({ counts: { review: 1 } });
    expect(services.slskd_rank).toHaveBeenCalledTimes(1);
  });

  it('honors a zero Jev budget and keeps candidates available for review', async () => {
    const paths = fixture({ ...base, jev_call_budget: 0 });
    const services = handlers([file, { ...file, file_id: 'b'.repeat(64) }]);
    expect(await runSlskdBulk(paths, services)).toMatchObject({ jev_calls: 0, counts: { review: 1 }, attention: [{ reason: 'jev_budget_exhausted' }] });
    expect(services.slskd_rank).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(paths.statePath, 'utf8')).items['track-1'].review_candidates).toHaveLength(2);
  });

  it('permits high margin Jev auto selection when the manifest opts in', async () => {
    const paths = fixture({ ...base, auto_select_jev: true });
    const services = handlers([file, { ...file, file_id: 'b'.repeat(64) }]);
    expect(await runSlskdBulk({ ...paths, download: true }, services)).toMatchObject({ counts: { queued: 1 } });
    expect(services.slskd_download).toHaveBeenCalledTimes(1);
  });

  it('uses a reviewed public candidate from an approvals file without searching again', async () => {
    const paths = fixture(base);
    const services = handlers([file, { ...file, file_id: 'b'.repeat(64), title: 'Artist Song live.mp3' }]);
    await runSlskdBulk(paths, services);
    const approvalsPath = join(paths.manifestPath, '..', 'approvals.json');
    writeFileSync(approvalsPath, JSON.stringify({ version: 1, choices: [{ id: 'track-1', file_id: file.file_id }] }));
    expect(await runSlskdBulk({ ...paths, approvalsPath, download: true }, services)).toMatchObject({ counts: { queued: 1 } });
    expect(services.slskd_search).toHaveBeenCalledTimes(1);
  });

  it('does not retry an uncertain download mutation', async () => {
    const paths = fixture(base);
    const services = handlers();
    services.slskd_download = vi.fn(async () => ({ ok: false as const, error: { code: 'INTEGRATION_TIMEOUT', message: 'Timed out' } }));
    services.slskd_batch = vi.fn(async () => { throw new Error('process interrupted'); });
    await expect(runSlskdBulk({ ...paths, download: true }, services)).rejects.toThrow('process interrupted');
    const state = JSON.parse(readFileSync(paths.statePath, 'utf8'));
    expect(state.items['track-1'].status).toBe('download_intent');
    const batchId = state.items['track-1'].batch_id;
    services.slskd_batch = vi.fn(async () => ({ ok: true as const, data: { id: batchId, transfers: [{ id: 'transfer' }] } }));
    expect(await runSlskdBulk({ ...paths, download: true }, services)).toMatchObject({ counts: { queued: 1 } });
    expect(services.slskd_download).toHaveBeenCalledTimes(1);
  });

  it('reviews a missing batch after bounded reconciliation without a second download', async () => {
    const paths = fixture(base);
    const services = handlers();
    services.slskd_download = vi.fn(async () => ({ ok: false as const, error: { code: 'INTEGRATION_TIMEOUT', message: 'Interrupted' } }));
    services.slskd_batch = vi.fn(async () => ({ ok: false as const, error: { code: 'INTEGRATION_NOT_FOUND', message: 'Missing' } }));
    expect(await runSlskdBulk({ ...paths, download: true, recoveryMs: 1 }, services)).toMatchObject({ counts: { review: 1 }, attention: [{ reason: 'download_outcome_uncertain' }] });
    expect(services.slskd_batch).toHaveBeenCalledTimes(3);
    expect(services.slskd_download).toHaveBeenCalledTimes(1);
  });

  it('rejects edited manifests and duplicate track IDs before searching', async () => {
    const paths = fixture(base);
    const services = handlers();
    await runSlskdBulk(paths, services);
    writeFileSync(paths.manifestPath, JSON.stringify({ ...base, tracks: [{ id: 'different', query: 'Artist Song' }] }));
    await expect(runSlskdBulk(paths, services)).rejects.toThrow('State does not match');
    writeFileSync(paths.manifestPath, JSON.stringify({ ...base, tracks: [base.tracks[0], base.tracks[0]] }));
    await expect(runSlskdBulk({ ...paths, plan: true }, services)).rejects.toThrow('Track IDs must be unique');
    writeFileSync(paths.manifestPath, JSON.stringify({ ...base, filters: { min_size_bytes: 10, max_size_bytes: 1 } }));
    await expect(runSlskdBulk({ ...paths, plan: true }, services)).rejects.toThrow('min_size_bytes');
  });

  it('stops after three consecutive permanent service failures', async () => {
    const paths = fixture({ version: 1, tracks: Array.from({ length: 5 }, (_, index) => ({ id: `song-${index}`, query: 'Artist Song' })) });
    const services = handlers();
    services.slskd_search = vi.fn(async () => ({ ok: false as const, error: { code: 'INTEGRATION_AUTH_FAILED', message: 'Failed' } }));
    expect(await runSlskdBulk(paths, services)).toMatchObject({ counts: { error: 3, unprocessed: 2 }, stopped_reason: 'three_consecutive_errors' });
    expect(services.slskd_search).toHaveBeenCalledTimes(3);
  });

  it('waits through a transient search failure and resumes the same checkpointed ID', async () => {
    const paths = fixture(base);
    const services = handlers();
    const search = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'INTEGRATION_TIMEOUT', message: 'Interrupted' } })
      .mockResolvedValueOnce({ ok: true, data: { search_id: 'accepted' } });
    const results = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'INTEGRATION_NOT_FOUND', message: 'Missing' } })
      .mockResolvedValueOnce({ ok: true, data: { isComplete: true, files: [file], total_matches: 1, truncated: false } });
    services.slskd_search = search;
    services.slskd_results = results;
    expect(await runSlskdBulk({ ...paths, recoveryMs: 1 }, services)).toMatchObject({ counts: { selected: 1 } });
    const ids = search.mock.calls.map((call) => (call[0] as { search_id: string }).search_id);
    expect(ids[0]).toBe(ids[1]);
    expect(JSON.parse(readFileSync(paths.statePath, 'utf8')).items['track-1'].search_id).toBe(ids[0]);
  });

  it('waits for temporary result transport failures after sleep', async () => {
    const paths = fixture(base);
    const services = handlers();
    services.slskd_results = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'INTEGRATION_TIMEOUT', message: 'Slept' } })
      .mockResolvedValueOnce({ ok: true, data: { isComplete: true, files: [file], total_matches: 1, truncated: false } });
    expect(await runSlskdBulk({ ...paths, recoveryMs: 1 }, services)).toMatchObject({ counts: { selected: 1 } });
    expect(services.slskd_results).toHaveBeenCalledTimes(2);
  });

  it('discards an empty search completed across a long laptop sleep', async () => {
    const paths = fixture(base);
    let clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const services = handlers();
    services.slskd_results = vi.fn()
      .mockImplementationOnce(async () => { clock += 3_600_000; return { ok: true, data: { isComplete: true, files: [], total_matches: 0, truncated: false } }; })
      .mockResolvedValueOnce({ ok: false, error: { code: 'INTEGRATION_NOT_FOUND', message: 'Missing' } })
      .mockResolvedValueOnce({ ok: true, data: { isComplete: true, files: [file], total_matches: 1, truncated: false } });
    expect(await runSlskdBulk({ ...paths, recoveryMs: 1 }, services)).toMatchObject({ counts: { selected: 1 } });
    expect(services.slskd_search).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(paths.statePath, 'utf8')).items['track-1'].search_restarts).toBe(1);
  });
});
