import { describe, expect, it } from 'vitest';
import { segmentText } from '../segment/segment';
import type { Word } from '../types';
import {
  DEFAULT_TIMING,
  MeanTracker,
  baseInterval,
  coreDuration,
  pauseFactor,
  spilled,
  summarizePace,
  wordDuration,
  type Pacing,
  type TimingSettings,
} from './timing';

/** Deterministic pseudo-random numbers so failures reproduce. */
function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

function randomSurprisal(n: number, seed = 1): Float32Array {
  const r = rng(seed);
  return Float32Array.from({ length: n }, () => 0.2 + r() * 18);
}

function plainWords(n: number, text = 'word'): Word[] {
  return Array.from({ length: n }, (_, index) => ({
    index,
    text,
    paragraphIndex: 0,
    sentenceEnd: false,
    paragraphEnd: false,
  }));
}

const mean = (a: ArrayLike<number>) => Array.from(a).reduce((x, y) => x + y, 0) / a.length;
const T = baseInterval(DEFAULT_TIMING);
const noLength: TimingSettings = { ...DEFAULT_TIMING, lengthMsPerChar: 0 };
const unclamped: TimingSettings = { ...noLength, minMs: 0, maxFactor: 1e9 };

describe('spillover', () => {
  it('preserves the sum for any L', () => {
    const s = randomSurprisal(500, 7);
    const total = Array.from(s).reduce((a, b) => a + b, 0);
    for (const L of [0, 0.1, 0.25, 0.5, 0.9]) {
      let sum = 0;
      for (let i = 0; i < s.length; i++) sum += spilled(s, i, L);
      expect(sum).toBeCloseTo(total, 2);
    }
  });

  it('moves a fraction L of each word onto the next', () => {
    const s = Float32Array.from([8, 0, 0]);
    expect(spilled(s, 0, 0.25)).toBeCloseTo(6);
    expect(spilled(s, 1, 0.25)).toBeCloseTo(2);
    expect(spilled(s, 2, 0.25)).toBeCloseTo(0);
  });

  it('is the identity at L = 0', () => {
    const s = randomSurprisal(20, 3);
    for (let i = 0; i < s.length; i++) expect(spilled(s, i, 0)).toBeCloseTo(s[i], 5);
  });

  it('is NaN for an unscored word and ignores an unscored predecessor', () => {
    const s = Float32Array.from([NaN, 6, NaN]);
    expect(spilled(s, 0, 0.25)).toBeNaN();
    expect(spilled(s, 1, 0.25)).toBeCloseTo(6);
    expect(spilled(s, 2, 0.25)).toBeNaN();
  });
});

describe('mix', () => {
  it('gives exactly T for every word at A = 0, whatever the surprisal', () => {
    const st = { ...DEFAULT_TIMING, strength: 0 };
    for (const s of [0, 0.5, 7, 25, 1000]) expect(coreDuration(s, 4, 7, st)).toBe(T);
  });

  it('A = 0 needs no surprisal at all', () => {
    const words = plainWords(5);
    const unscored = new Float32Array(5).fill(NaN);
    const p: Pacing = { settings: { ...DEFAULT_TIMING, strength: 0 }, meanS: 7, fixed: false };
    for (let i = 0; i < 5; i++) expect(wordDuration(words, unscored, i, p)).toBe(T);
  });

  it('fixed mode matches A = 0', () => {
    const words = plainWords(50);
    const s = randomSurprisal(50, 11);
    const fixed: Pacing = { settings: DEFAULT_TIMING, meanS: mean(s), fixed: true };
    const zero: Pacing = { settings: { ...DEFAULT_TIMING, strength: 0 }, meanS: mean(s), fixed: false };
    for (let i = 0; i < 50; i++) {
      expect(wordDuration(words, s, i, fixed)).toBe(wordDuration(words, s, i, zero));
    }
  });

  it('has an unclamped mean duration of T before pauses', () => {
    const words = plainWords(2000);
    const s = randomSurprisal(2000, 5);
    for (const strength of [0.3, 0.7, 1]) {
      for (const spillover of [0, 0.25, 0.6]) {
        const p: Pacing = { settings: { ...unclamped, strength, spillover }, meanS: mean(s), fixed: false };
        const durations = words.map((_, i) => wordDuration(words, s, i, p));
        expect(mean(durations)).toBeCloseTo(T, 3);
      }
    }
  });

  it('is linear in surprisal', () => {
    const d = (s: number) => coreDuration(s, 4, 8, unclamped);
    expect(d(6) - d(2)).toBeCloseTo(d(14) - d(10), 9);
    expect(d(8)).toBeCloseTo(T, 9);
    expect(d(16) - d(8)).toBeCloseTo(unclamped.strength * T, 9);
  });

  it('is monotone non-decreasing in surprisal, clamps included', () => {
    let last = -Infinity;
    for (let s = 0; s <= 40; s += 0.25) {
      const d = coreDuration(s, 6, 7, DEFAULT_TIMING);
      expect(d).toBeGreaterThanOrEqual(last);
      last = d;
    }
  });

  it('falls back to a ratio of 1 when the mean is not positive', () => {
    expect(coreDuration(5, 4, 0, DEFAULT_TIMING)).toBe(T);
  });
});

describe('length bonus', () => {
  it('adds 8 ms per character beyond 8', () => {
    const st = { ...DEFAULT_TIMING, strength: 0 };
    expect(coreDuration(7, 8, 7, st)).toBe(T);
    expect(coreDuration(7, 9, 7, st)).toBe(T + 8);
    expect(coreDuration(7, 14, 7, st)).toBe(T + 48);
  });

  it('counts code points, not UTF-16 units', () => {
    const words = plainWords(1, '𝒜𝒜𝒜𝒜𝒜𝒜𝒜𝒜');
    const p: Pacing = { settings: { ...DEFAULT_TIMING, strength: 0 }, meanS: 7, fixed: false };
    expect(wordDuration(words, Float32Array.from([7]), 0, p)).toBe(T);
  });
});

describe('clamps', () => {
  it('holds for every word', () => {
    const words = plainWords(1000);
    const s = randomSurprisal(1000, 9);
    s[10] = 0;
    s[20] = 25;
    const st = { ...DEFAULT_TIMING, strength: 1 };
    const p: Pacing = { settings: st, meanS: mean(s), fixed: false };
    for (let i = 0; i < words.length; i++) {
      const d = wordDuration(words, s, i, p);
      expect(d).toBeGreaterThanOrEqual(st.minMs);
      expect(d).toBeLessThanOrEqual(st.maxFactor * T);
    }
  });

  it('clamps to minMs and maxFactor * T', () => {
    const st = { ...DEFAULT_TIMING, strength: 1 };
    expect(coreDuration(0, 4, 7, st)).toBe(st.minMs);
    expect(coreDuration(1000, 4, 7, st)).toBe(st.maxFactor * T);
  });

  it('never lets the maximum fall below the minimum', () => {
    const st = { ...DEFAULT_TIMING, targetWpm: 1200, minMs: 300, maxFactor: 1 };
    expect(coreDuration(50, 4, 7, st)).toBe(300);
  });
});

describe('pauses', () => {
  const { words } = segmentText('Well, yes; no: maybe \u2014 so. Next one!\n\nLast (really,) "done."');
  const factor = (text: string) => pauseFactor(words.find((w) => w.text === text)!, DEFAULT_TIMING);

  it('adds half a beat after clause punctuation and dashes', () => {
    expect(factor('Well,')).toBe(0.5);
    expect(factor('yes;')).toBe(0.5);
    expect(factor('no:')).toBe(0.5);
    expect(factor('\u2014')).toBe(0.5);
    expect(factor('(really,)')).toBe(0.5);
    expect(factor('maybe')).toBe(0);
  });

  it('adds one beat at a sentence end and two at a paragraph end, not both', () => {
    expect(factor('so.')).toBe(1);
    expect(factor('one!')).toBe(2);
    expect(factor('"done."')).toBe(2);
  });

  it('is added after clamping', () => {
    const st = { ...DEFAULT_TIMING, strength: 1 };
    const s = new Float32Array(words.length).fill(1000);
    const i = words.findIndex((w) => w.text === 'so.');
    const d = wordDuration(words, s, i, { settings: st, meanS: 7, fixed: false });
    expect(d).toBe(st.maxFactor * T + st.pauseSentence * T);
  });

  it('does not pause on a hyphen left by splitting a long chunk', () => {
    const split = segmentText('state-of-the-art-machine-learning').words;
    expect(split[0].text.endsWith('-')).toBe(true);
    expect(pauseFactor(split[0], DEFAULT_TIMING)).toBe(0);
  });
});

describe('unscored words', () => {
  it('have no duration in surprisal mode', () => {
    const words = plainWords(3);
    const s = Float32Array.from([5, NaN, NaN]);
    const p: Pacing = { settings: DEFAULT_TIMING, meanS: 7, fixed: false };
    expect(wordDuration(words, s, 0, p)).not.toBeNaN();
    expect(wordDuration(words, s, 1, p)).toBeNaN();
  });
});

describe('MeanTracker', () => {
  it('starts at the seed and converges on the data', () => {
    const m = new MeanTracker(7, 50);
    expect(m.mean).toBe(7);
    for (let i = 0; i < 50; i++) m.add(9);
    expect(m.mean).toBeCloseTo(8);
    for (let i = 0; i < 100000; i++) m.add(9);
    expect(m.mean).toBeCloseTo(9, 2);
    expect(m.count).toBe(100050);
  });

  it('is the plain mean with no pseudo-count', () => {
    const m = new MeanTracker(7, 0);
    m.add(2);
    m.add(4);
    expect(m.mean).toBe(3);
  });
});

describe('summarizePace', () => {
  it('reports the target rate for fixed pacing without pauses', () => {
    const words = plainWords(100);
    const s = new Float32Array(100).fill(NaN);
    const summary = summarizePace(words, s, { settings: DEFAULT_TIMING, meanS: 7, fixed: true })!;
    expect(summary.timedWords).toBe(100);
    expect(summary.effectiveWpm).toBeCloseTo(DEFAULT_TIMING.targetWpm, 6);
  });

  it('reports a lower effective rate once pauses are included', () => {
    const { words } = segmentText('One, two. Three four five. Six!');
    const s = new Float32Array(words.length).fill(7);
    const summary = summarizePace(words, s, { settings: noLength, meanS: 7, fixed: false })!;
    expect(summary.effectiveWpm).toBeLessThan(noLength.targetWpm);
  });

  it('is null when nothing can be timed yet', () => {
    const words = plainWords(3);
    const s = new Float32Array(3).fill(NaN);
    expect(summarizePace(words, s, { settings: DEFAULT_TIMING, meanS: 7, fixed: false })).toBeNull();
  });
});
