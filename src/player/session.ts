import { segment } from '../segment/segment';
import { MeanTracker } from '../timing/timing';
import { newSurprisal, type Surprisal, type Word } from '../types';

/**
 * Everything the player needs for one open document: its words, the surprisal
 * scored so far, and the running mean used to normalize durations. Scores
 * arrive in batches from the worker; subscribers are told after each batch.
 */
export class ReaderSession {
  readonly words: Word[];
  readonly surprisal: Surprisal;
  readonly mean: MeanTracker;
  private scored = 0;
  private rev = 0;
  private listeners = new Set<() => void>();

  /** `text` must already be normalized (see normalizeText). */
  constructor(
    readonly text: string,
    meanSeed: number,
  ) {
    this.words = segment(text);
    this.surprisal = newSurprisal(this.words.length);
    this.mean = new MeanTracker(meanSeed);
  }

  /** Store scores for words [start, start + bits.length). Already-scored words keep their value. */
  applyScores(start: number, bits: ArrayLike<number>): void {
    let added = 0;
    for (let k = 0; k < bits.length; k++) {
      const i = start + k;
      const v = bits[k];
      if (i >= this.surprisal.length || Number.isNaN(v) || !Number.isNaN(this.surprisal[i])) continue;
      this.surprisal[i] = v;
      this.mean.add(v);
      added++;
    }
    if (added) {
      this.scored += added;
      this.rev++;
      for (const fn of this.listeners) fn();
    }
  }

  isScored(i: number): boolean {
    return !Number.isNaN(this.surprisal[i]);
  }

  get scoredCount(): number {
    return this.scored;
  }

  get complete(): boolean {
    return this.scored === this.words.length;
  }

  /** Changes whenever scores are added; usable as a useSyncExternalStore snapshot. */
  get version(): number {
    return this.rev;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
}
