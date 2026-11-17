import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeText } from '../src/segment/segment';
import type { TokenizerLike } from '../src/surprisal/align';
import { rowLogProb, targetLogProbs } from '../src/surprisal/logprob';
import { DocumentScorer, MAX_WORD_BITS, type ForwardFn, type ScoreRun } from '../src/surprisal/scorer';
import { passage } from './helpers/fixtures';
import { gpt2Tokenizer } from './helpers/tokenizer';

const V = 50257;

/**
 * A fake model whose next-token distribution depends only on the current
 * token, so exact results are known and independent of windowing.
 */
function fakeLogit(prev: number, k: number): number {
  return (((k * 31 + prev * 17) % 97) - 48) / 8;
}

function fakeBits(prev: number, next: number): number {
  const row = new Float64Array(V);
  for (let k = 0; k < V; k++) row[k] = fakeLogit(prev, k);
  return -rowLogProb(row, 0, V, next) / Math.LN2;
}

const rowCache = new Map<number, Float32Array>();
function fakeRow(prev: number): Float32Array {
  let row = rowCache.get(prev);
  if (!row) {
    row = new Float32Array(V);
    for (let k = 0; k < V; k++) row[k] = fakeLogit(prev, k);
    rowCache.set(prev, row);
  }
  return row;
}

const fakeForward: ForwardFn = async (ids) => {
  const data = new Float32Array(ids.length * V);
  for (let r = 0; r < ids.length; r++) data.set(fakeRow(ids[r]), r * V);
  return { logits: { data, dims: [1, ids.length, V], type: 'float32' }, release: () => {} };
};

let tok: TokenizerLike;
beforeAll(async () => {
  tok = await gpt2Tokenizer();
});

function collect(runs: ScoreRun[], out: Float32Array) {
  for (const r of runs) {
    for (let k = 0; k < r.bits.length; k++) {
      expect(Number.isNaN(out[r.start + k])).toBe(true); // each word arrives once
      out[r.start + k] = r.bits[k];
    }
  }
}

async function scoreAll(text: string, window: number, stride: number, priority = 0) {
  const scorer = new DocumentScorer(tok, text, { verifyText: true });
  const out = new Float32Array(scorer.words.length).fill(NaN);
  const status = await scorer.run({ forward: fakeForward, window, stride, priority: () => priority, onScores: (r) => collect(r, out) });
  return { scorer, out, status };
}

describe('logprob', () => {
  it('computes a stable log-softmax entry', () => {
    const row = [1000, 1000, 1000, 1000];
    expect(rowLogProb(row, 0, 4, 2)).toBeCloseTo(Math.log(0.25), 12);
    expect(rowLogProb([0, Math.log(3)], 0, 2, 1)).toBeCloseTo(Math.log(0.75), 12);
  });

  it('decodes raw float16 logits', () => {
    // Half-precision bits for 1.0, 2.0, -2.0, 0.5.
    const half = new Uint16Array([0x3c00, 0x4000, 0xc000, 0x3800]);
    const f32 = new Float32Array([1, 2, -2, 0.5]);
    const a = targetLogProbs({ data: half, dims: [1, 1, 4], type: 'float16' }, [0], [1]);
    const b = targetLogProbs({ data: f32, dims: [1, 1, 4], type: 'float32' }, [0], [1]);
    expect(a[0]).toBeCloseTo(b[0], 12);
  });
});

describe('DocumentScorer', () => {
  const text = passage('austen');

  it('gives every word the sum of its tokens, independent of windowing', async () => {
    const a = await scoreAll(text, 1024, 1024);
    const b = await scoreAll(text, 128, 64);
    const c = await scoreAll(text, 64, 7, 300);
    expect(a.status).toBe('complete');
    // `a` is a single forward pass; the others need many windows.
    expect(a.scorer.tokenCount).toBeLessThanOrEqual(1024);
    expect(a.scorer.tokenCount).toBeGreaterThan(512);
    for (const r of [a, b, c]) expect(r.out.every((v) => !Number.isNaN(v))).toBe(true);
    for (let i = 0; i < a.out.length; i++) {
      expect(b.out[i]).toBeCloseTo(a.out[i], 4);
      expect(c.out[i]).toBeCloseTo(a.out[i], 4);
    }

    // Check a few words against the analytic answer.
    const { alignment: al } = a.scorer;
    for (const c of [0, 1, 7, 100]) {
      let expected = 0;
      for (let j = al.groupStart[c]; j < al.groupEnd[c]; j++) expected += fakeBits(al.ids[j - 1], al.ids[j]);
      expect(a.out[a.scorer.first[c]]).toBeCloseTo(Math.min(MAX_WORD_BITS, expected), 3);
    }
  });

  it('splits a long chunk evenly across its display pieces', async () => {
    const t = normalizeText('Read https://example.com/a/very/long-path/with-many-parts/index.html today.');
    const { scorer, out } = await scoreAll(t, 512, 256);
    const c = 1;
    const pieces = scorer.first[c + 1] - scorer.first[c];
    expect(pieces).toBeGreaterThan(1);
    const total = scorer.chunkSurprisal()[c];
    for (let w = scorer.first[c]; w < scorer.first[c + 1]; w++) {
      expect(out[w]).toBeCloseTo(Math.min(MAX_WORD_BITS, total / pieces), 4);
    }
  });

  it('scores the priority word first', async () => {
    const scorer = new DocumentScorer(tok, text);
    const target = Math.floor(scorer.words.length * 0.7);
    let first: ScoreRun[] | null = null;
    await scorer.run({
      forward: fakeForward,
      window: 128,
      stride: 64,
      priority: () => target,
      onScores: (r) => {
        first ??= r;
      },
    });
    expect(first![0].start).toBeLessThanOrEqual(target);
    expect(first![0].start + first![0].bits.length).toBeGreaterThan(target);
  });

  it('skips words already known from the cache', async () => {
    const scorer = new DocumentScorer(tok, text);
    const known = new Float32Array(scorer.words.length).fill(NaN);
    known.fill(5, 0, 200);
    scorer.markKnown(known);
    const seen = new Float32Array(scorer.words.length).fill(NaN);
    let calls = 0;
    await scorer.run({
      forward: async (ids) => {
        calls++;
        return fakeForward(ids);
      },
      window: 128,
      stride: 64,
      onScores: (r) => collect(r, seen),
    });
    for (let i = 0; i < 200; i++) expect(Number.isNaN(seen[i])).toBe(true);
    for (let i = 200; i < seen.length; i++) expect(Number.isNaN(seen[i])).toBe(false);
    expect(scorer.complete).toBe(true);
    const full = await scoreAll(text, 128, 64);
    expect(calls).toBeLessThan(full.scorer.tokenCount / 64);
  });

  it('stops between windows when cancelled', async () => {
    const scorer = new DocumentScorer(tok, text);
    let windows = 0;
    const status = await scorer.run({
      forward: fakeForward,
      window: 128,
      stride: 64,
      cancelled: () => windows >= 2,
      onScores: () => windows++,
    });
    expect(status).toBe('cancelled');
    expect(scorer.complete).toBe(false);
  });
});
