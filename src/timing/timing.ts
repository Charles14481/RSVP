import type { Surprisal, Word } from '../types';

export interface TimingSettings {
  /** Target reading rate before pauses. T = 60000 / targetWpm. */
  targetWpm: number;
  /** A in [0, 1]: how much of each word's duration follows surprisal. 0 = fixed rate. */
  strength: number;
  /** L in [0, 1): fraction of a word's surprisal that carries over to the next word. */
  spillover: number;
  /** Lower clamp in ms. */
  minMs: number;
  /** Upper clamp as a multiple of T. */
  maxFactor: number;
  /** Extra ms per character beyond lengthThreshold. */
  lengthMsPerChar: number;
  lengthThreshold: number;
  /** Pauses as multiples of T, added after clamping. */
  pauseClause: number;
  pauseSentence: number;
  pauseParagraph: number;
}

export const DEFAULT_TIMING: TimingSettings = {
  targetWpm: 300,
  strength: 0.7,
  spillover: 0.25,
  minMs: 80,
  maxFactor: 4,
  lengthMsPerChar: 8,
  lengthThreshold: 8,
  pauseClause: 0.5,
  pauseSentence: 1.0,
  pauseParagraph: 2.0,
};

export const WPM_MIN = 100;
export const WPM_MAX = 1200;
export const WPM_STEP = 25;

/** Words that carry more surprisal than this are almost always extraction junk. */
export const MAX_WORD_BITS = 25;

export function baseInterval(st: TimingSettings): number {
  return 60000 / st.targetWpm;
}

/**
 * Step 1, spillover. Each word passes a fraction L of its surprisal on to the
 * next word: s'_i = (1 - L) * s_i + L * s_(i-1). The last word has no
 * successor and keeps everything, so the total over a document is preserved
 * exactly. Returns NaN while word i is unscored. If only the previous word is
 * unscored (scoring began mid-document), word i keeps its own surprisal.
 */
export function spilled(s: Surprisal, i: number, L: number): number {
  const cur = s[i];
  if (Number.isNaN(cur)) return NaN;
  const kept = i === s.length - 1 ? cur : (1 - L) * cur;
  if (i === 0) return kept;
  const prev = s[i - 1];
  return kept + L * (Number.isNaN(prev) ? cur : prev);
}

/**
 * Steps 2 to 4: mix surprisal into the base interval, add the length bonus,
 * clamp. Linear in surprisal by construction.
 */
export function coreDuration(sEff: number, charCount: number, meanS: number, st: TimingSettings): number {
  const T = baseInterval(st);
  const ratio = meanS > 0 ? sEff / meanS : 1;
  const mixed = T * (1 - st.strength + st.strength * ratio);
  const withLength = mixed + st.lengthMsPerChar * Math.max(0, charCount - st.lengthThreshold);
  const maxMs = Math.max(st.minMs, st.maxFactor * T);
  return Math.min(maxMs, Math.max(st.minMs, withLength));
}

const CLOSERS = '["\'”’)\\]}»]*';
const CLAUSE_END = new RegExp(`(?:[,;:]|--|[\u2013\u2014])${CLOSERS}$`);
const DASH_ONLY = /^[-\u2013\u2014]+$/;

/** Step 5: pause multiplier of T for the punctuation this word ends with. */
export function pauseFactor(word: Word, st: TimingSettings): number {
  if (word.paragraphEnd) return st.pauseParagraph;
  if (word.sentenceEnd) return st.pauseSentence;
  if (CLAUSE_END.test(word.text) || DASH_ONLY.test(word.text)) return st.pauseClause;
  return 0;
}

function charCount(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

export interface Pacing {
  settings: TimingSettings;
  /** Mean word surprisal used to normalize (see MeanTracker). */
  meanS: number;
  /** Fixed-rate mode: every word is treated as having mean surprisal. */
  fixed: boolean;
}

/**
 * Full display duration of word i in ms including pauses, or NaN if the word
 * is unscored and the pacing needs its surprisal.
 */
export function wordDuration(words: readonly Word[], s: Surprisal, i: number, p: Pacing): number {
  const word = words[i];
  const st = p.settings;
  const usesSurprisal = !p.fixed && st.strength > 0;
  const sEff = usesSurprisal ? spilled(s, i, st.spillover) : p.meanS;
  if (Number.isNaN(sEff)) return NaN;
  return coreDuration(sEff, charCount(word.text), p.meanS, st) + pauseFactor(word, st) * baseInterval(st);
}

/**
 * Running mean of word surprisal, seeded with a per-model prior worth
 * `pseudoCount` words so the first few words of a document do not swing the
 * normalization.
 */
export class MeanTracker {
  private sum = 0;
  private n = 0;
  constructor(
    readonly seed: number,
    readonly pseudoCount = 50,
  ) {}

  add(bits: number): void {
    this.sum += bits;
    this.n++;
  }

  get count(): number {
    return this.n;
  }

  get mean(): number {
    const weight = this.pseudoCount + this.n;
    return weight > 0 ? (this.seed * this.pseudoCount + this.sum) / weight : this.seed;
  }
}

export interface PaceSummary {
  /** Words that could be timed (all of them in fixed mode). */
  timedWords: number;
  /** Mean ms per timed word including pauses and clamps. */
  meanMs: number;
  /** Effective reading rate including pauses and clamps. */
  effectiveWpm: number;
}

/** Effective rate over every word that can currently be timed. */
export function summarizePace(words: readonly Word[], s: Surprisal, p: Pacing): PaceSummary | null {
  let total = 0;
  let n = 0;
  for (let i = 0; i < words.length; i++) {
    const d = wordDuration(words, s, i, p);
    if (Number.isNaN(d)) continue;
    total += d;
    n++;
  }
  if (n === 0) return null;
  const meanMs = total / n;
  return { timedWords: n, meanMs, effectiveWpm: 60000 / meanMs };
}
