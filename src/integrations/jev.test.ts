import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JevRanker, type RankCandidate } from './jev.js';

const directory = mkdtempSync(join(tmpdir(), 'p2p-jev-test-'));
const keyFile = join(directory, 'key.txt');
writeFileSync(keyFile, 'fixture-secret');
afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('Jev ranking', () => {
  it('sends only search metadata and maps the choice back to a local selection ID', async () => {
    const fetcher = vi.fn(async (url, init) => {
      expect(url).toBe('https://api.typesafe.ai/v1/systemone');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer fixture-secret');
      const body = JSON.parse(String(init?.body));
      expect(body.state).toEqual({ requested_music: 'Artist Track', preferences: [] });
      expect(JSON.stringify(body)).not.toMatch(/private-id|remote-user|private\\folder/);
      expect(body.questions.best_match.criteria.candidate_0).toContain('Track.flac');
      return new Response(JSON.stringify({ model: 'jev-fixture', answers: { best_match: { type: 'choice', choice: 'candidate_0', probabilities: { none: 0.1, candidate_0: 0.9 }, confidence: 0.8 } } }));
    }) as typeof fetch;
    const ranker = new JevRanker({ apiKeyFile: keyFile, model: 'jev-latest', timeoutMs: 1000 }, fetcher);
    expect(await ranker.rank('Artist Track', [{ id: 'private-id', title: 'Track.flac', size_bytes: 12 }])).toMatchObject({ recommendation: 'private-id', ranked: [{ id: 'private-id', probability: 0.9 }] });
  });

  it('rejects duplicate IDs before calling the API', async () => {
    const fetcher = vi.fn() as typeof fetch;
    const ranker = new JevRanker({ apiKeyFile: keyFile, model: 'jev-latest', timeoutMs: 1000 }, fetcher);
    await expect(ranker.rank('q', [{ id: 'same', title: 'a' }, { id: 'same', title: 'b' }])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses explicit release preferences and rich metadata without sending usernames or full paths', async () => {
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.state).toEqual({ requested_music: 'Bach Cello Suite', preferences: ['Prefer 24-bit FLAC', 'Avoid live recordings'] });
      const criteria = body.questions.best_match.criteria.candidate_0 as string;
      expect(criteria).toContain('"bit_depth":24');
      expect(criteria).toContain('"preferred_source":true');
      expect(criteria).toContain('Cello Album');
      expect(criteria).not.toContain('Private Parent');
      expect(criteria).not.toContain('private-uploader');
      expect(JSON.stringify(body)).not.toContain('private-id');
      return new Response(JSON.stringify({ answers: { best_match: { type: 'choice', choice: 'candidate_0', probabilities: { none: 0.1, candidate_0: 0.9 }, confidence: 0.8 } } }));
    }) as typeof fetch;
    const ranker = new JevRanker({ apiKeyFile: keyFile, model: 'jev-latest', timeoutMs: 1000 }, fetcher);
    await ranker.rank('Bach Cello Suite', [{ id: 'private-id', title: 'Bach.flac', folder_name: 'Private Parent\\Cello Album', bit_depth: 24, preferred_source: true, username: 'private-uploader' } as RankCandidate], ['Prefer 24-bit FLAC', 'Avoid live recordings']);
  });

  it('does not leak an invalid credential or upstream response', async () => {
    const fetcher = vi.fn(async () => new Response('private upstream body', { status: 401 })) as typeof fetch;
    const ranker = new JevRanker({ apiKeyFile: keyFile, model: 'jev-latest', timeoutMs: 1000 }, fetcher);
    await expect(ranker.rank('q', [{ id: 'a', title: 'a' }])).rejects.toMatchObject({ code: 'JEV_AUTH_FAILED' });
  });

  it('ends at the deadline even if a transport ignores cancellation', async () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => {})) as typeof fetch;
    const ranker = new JevRanker({ apiKeyFile: keyFile, model: 'jev-latest', timeoutMs: 10 }, fetcher);
    await expect(ranker.rank('q', [{ id: 'a', title: 'a' }])).rejects.toMatchObject({ code: 'JEV_TIMEOUT' });
  });
});
