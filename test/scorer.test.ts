import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeText } from '../src/segment/segment';
import { wordInitialIds, type TokenizerLike } from '../src/surprisal/align';
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

  describe('boundary correction', () => {
    let bow: Int32Array;
    beforeAll(() => {
      bow = wordInitialIds(tok, V);
    });

    const bowBits = (prev: number) => {
      const row = fakeRow(prev);
      let max = -Infinity;
      for (let k = 0; k < V; k++) max = Math.max(max, row[k]);
      let all = 0;
      for (let k = 0; k < V; k++) all += Math.exp(row[k] - max);
      let s = 0;
      for (const id of bow) s += Math.exp(row[id] - max);
      return -Math.log2(s / all);
    };

    it('uses whitespace-initial tokens plus EOS as word starts', () => {
      const has = (id: number) => bow.includes(id);
      expect(has(220)).toBe(true); // " "
      expect(has(198)).toBe(true); // "\n"
      expect(has(262)).toBe(true); // " the"
      expect(has(50256)).toBe(true); // <|endoftext|>
      expect(has(1169)).toBe(false); // "the"
      expect(has(13)).toBe(false); // "."
      expect(bow.length).toBeGreaterThan(15000);
      expect(bow.length).toBeLessThan(40000);
    });

    async function scoreBoundary(t: string, window: number, stride: number) {
      const scorer = new DocumentScorer(tok, t, { verifyText: true, boundaryIds: bow });
      const out = new Float32Array(scorer.words.length).fill(NaN);
      await scorer.run({ forward: fakeForward, window, stride, onScores: (r) => collect(r, out) });
      return { scorer, out };
    }

    it('telescopes within a paragraph: the corrections cancel except at its end', async () => {
      const { scorer } = await scoreBoundary(text, 128, 64);
      expect(scorer.complete).toBe(true);
      const al = scorer.alignment;
      const plain = scorer.chunkSurprisal();
      const corrected = scorer.chunkValues();
      const words = scorer.words;
      let start = 0;
      for (let c = 0; c < scorer.chunks.length; c++) {
        if (!words[scorer.first[c + 1] - 1].paragraphEnd) continue;
        let sumPlain = 0;
        let sumCorr = 0;
        for (let k = start; k <= c; k++) {
          sumPlain += plain[k];
          sumCorr += corrected[k];
        }
        const e = al.groupEnd[c];
        const lastAfter = e < al.ids.length ? scorer.boundaryBits![e] : 0;
        expect(sumCorr).toBeCloseTo(sumPlain + lastAfter, 3);
        start = c + 1;
      }
    });

    it('matches the analytic correction for a word and does not depend on windowing', async () => {
      const a = await scoreBoundary(text, 1024, 1024);
      const b = await scoreBoundary(text, 64, 16);
      for (let i = 0; i < a.out.length; i++) expect(b.out[i]).toBeCloseTo(a.out[i], 4);

      const { scorer } = a;
      const al = scorer.alignment;
      const c = 5; // a mid-sentence word with a leading space
      const s = al.groupStart[c];
      const e = al.groupEnd[c];
      let tokens = 0;
      for (let j = s; j < e; j++) tokens += fakeBits(al.ids[j - 1], al.ids[j]);
      const expected = tokens + bowBits(al.ids[e - 1]) - bowBits(al.ids[s - 1]);
      expect(scorer.chunkValue(c)).toBeCloseTo(expected, 3);
      expect(scorer.chunkValue(c)).not.toBeCloseTo(tokens, 3);
      // The document's first word has no preceding space: no "before" factor.
      expect(scorer.chunkValue(0)).toBeCloseTo(scorer.chunkSurprisal()[0] + bowBits(al.ids[al.groupEnd[0] - 1]), 3);
    });

    it('skips words known from the cache in boundary mode too', async () => {
      const scorer = new DocumentScorer(tok, text, { boundaryIds: bow });
      scorer.markKnown(new Float32Array(scorer.words.length).fill(3));
      expect(scorer.complete).toBe(true);
      let calls = 0;
      await scorer.run({ forward: async (ids) => (calls++, fakeForward(ids)), window: 128, stride: 64 });
      expect(calls).toBe(0);
    });
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
