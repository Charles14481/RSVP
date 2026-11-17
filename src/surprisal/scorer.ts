import { chunksOf, segment } from '../segment/segment';
import type { Word } from '../types';
import { alignText, verifyAlignment, type Alignment, type TokenizerLike } from './align';
import { targetLogProbs, LOG2E, type LogitsTensor } from './logprob';
import { planWindow, type Window } from './windows';

/** Words with more surprisal than this are almost always extraction junk. */
export const MAX_WORD_BITS = 25;

export interface ForwardResult {
  logits: LogitsTensor;
  /** Free the output tensors. */
  release(): void;
}

/** Run the model on one window of token ids and return its logits, shape [1, n, V]. */
export type ForwardFn = (ids: Int32Array) => Promise<ForwardResult>;

/** A contiguous run of finished display-word surprisals. */
export interface ScoreRun {
  start: number;
  bits: Float32Array;
}

export interface ScorerOptions {
  /** Decode every group and compare it with its word (tests and dev builds). */
  verifyText?: boolean;
}

export interface RunOptions {
  forward: ForwardFn;
  window: number;
  stride: number;
  /** Display word to score first; read before every window so it can change mid-run. */
  priority?: () => number;
  /** Polled between windows. */
  cancelled?: () => boolean;
  /** Finished words after each window. */
  onScores?: (runs: ScoreRun[], window: Window) => void;
}

/**
 * Scores one document: tokenizes and aligns once, then turns windows of logits
 * into per-word surprisal in bits. Independent of the browser so the same code
 * runs in the worker and in the Node reference test.
 */
export class DocumentScorer {
  readonly words: Word[];
  readonly chunks: string[];
  /** first[c] is the first display word of chunk c. */
  readonly first: Int32Array;
  readonly alignment: Alignment;
  /** Surprisal in bits of each token as a target (index 0, the BOS, stays NaN). */
  readonly tokenBits: Float32Array;
  /** 1 once a target needs no more work: scored, belongs to no word, or its word was already known. */
  private readonly done: Uint8Array;
  private readonly remaining: Int32Array;
  private readonly chunkBits: Float64Array;
  private readonly chunkOfWord: Int32Array;
  private finishedChunks = 0;

  constructor(
    tokenizer: TokenizerLike,
    readonly text: string,
    options: ScorerOptions = {},
  ) {
    this.words = segment(text);
    const { chunks, first } = chunksOf(this.words);
    this.chunks = chunks;
    this.first = first;
    this.alignment = alignText(tokenizer, text);
    verifyAlignment(this.alignment, chunks, tokenizer, options.verifyText ?? false);

    const al = this.alignment;
    const n = al.ids.length;
    this.tokenBits = new Float32Array(n).fill(NaN);
    this.done = new Uint8Array(n);
    this.done[0] = 1;
    for (let j = 1; j < n; j++) if (al.groupOf[j] < 0) this.done[j] = 1;
    this.remaining = new Int32Array(al.groupCount);
    for (let g = 0; g < al.groupCount; g++) this.remaining[g] = al.groupEnd[g] - al.groupStart[g];
    this.chunkBits = new Float64Array(al.groupCount);
    this.chunkOfWord = new Int32Array(this.words.length);
    for (let c = 0; c < chunks.length; c++) this.chunkOfWord.fill(c, first[c], first[c + 1]);
  }

  get tokenCount(): number {
    return this.alignment.ids.length;
  }

  get complete(): boolean {
    return this.finishedChunks === this.chunks.length;
  }

  /** Mark words whose surprisal is already known (from the cache) so they are not rescored. */
  markKnown(known: ArrayLike<number>): void {
    const al = this.alignment;
    for (let c = 0; c < this.chunks.length; c++) {
      if (this.remaining[c] === 0) continue;
      let all = true;
      for (let w = this.first[c]; w < this.first[c + 1]; w++) if (Number.isNaN(known[w])) all = false;
      if (!all) continue;
      for (let j = al.groupStart[c]; j < al.groupEnd[c]; j++) this.done[j] = 1;
      this.remaining[c] = 0;
      this.finishedChunks++;
    }
  }

  /** The first token of the chunk containing display word w. */
  tokenOfWord(w: number): number {
    if (this.words.length === 0) return 1;
    const c = this.chunkOfWord[Math.max(0, Math.min(this.words.length - 1, w))];
    return this.alignment.groupStart[c];
  }

  /** Score windows until the document is finished or the run is cancelled. */
  async run(opts: RunOptions): Promise<'complete' | 'cancelled'> {
    const hint = { pos: 0 };
    let lastCursor = -1;
    while (!this.complete) {
      if (opts.cancelled?.()) return 'cancelled';
      const cursor = this.tokenOfWord(opts.priority?.() ?? 0);
      if (cursor !== lastCursor) {
        hint.pos = 0;
        lastCursor = cursor;
      }
      const win = planWindow(this.done, opts.window, opts.stride, cursor, hint);
      if (!win) break;
      const ids = this.alignment.ids.subarray(win.start, win.end);
      const result = await opts.forward(ids);
      let runs: ScoreRun[];
      try {
        runs = this.ingest(win, result.logits);
      } finally {
        result.release();
      }
      if (opts.cancelled?.()) return 'cancelled';
      if (runs.length) opts.onScores?.(runs, win);
    }
    return 'complete';
  }

  /** Turn a window's logits into token surprisals and return the words they finish. */
  ingest(win: Window, logits: LogitsTensor): ScoreRun[] {
    const al = this.alignment;
    const rowsInLogits = logits.dims[logits.dims.length - 2];
    if (rowsInLogits !== win.end - win.start) {
      throw new Error(`Expected ${win.end - win.start} logits rows, got ${rowsInLogits}`);
    }
    const rows: number[] = [];
    const targets: number[] = [];
    const js: number[] = [];
    for (let j = win.from; j <= win.to; j++) {
      if (this.done[j]) continue;
      rows.push(j - 1 - win.start);
      targets.push(al.ids[j]);
      js.push(j);
    }
    const logp = targetLogProbs(logits, rows, targets);

    const finished: number[] = [];
    for (let k = 0; k < js.length; k++) {
      const j = js[k];
      const bits = -logp[k] * LOG2E;
      this.tokenBits[j] = bits;
      this.done[j] = 1;
      const g = al.groupOf[j];
      this.chunkBits[g] += bits;
      if (--this.remaining[g] === 0) finished.push(g);
    }
    this.finishedChunks += finished.length;
    return this.toRuns(finished);
  }

  /** Display-word values for finished chunks, merged into contiguous runs. */
  private toRuns(finished: number[]): ScoreRun[] {
    if (finished.length === 0) return [];
    finished.sort((a, b) => a - b);
    const runs: ScoreRun[] = [];
    let i = 0;
    while (i < finished.length) {
      let k = i;
      while (k + 1 < finished.length && finished[k + 1] === finished[k] + 1) k++;
      const start = this.first[finished[i]];
      const end = this.first[finished[k] + 1];
      const bits = new Float32Array(end - start);
      for (let c = finished[i]; c <= finished[k]; c++) {
        const pieces = this.first[c + 1] - this.first[c];
        const each = Math.min(MAX_WORD_BITS, this.chunkBits[c] / pieces);
        bits.fill(each, this.first[c] - start, this.first[c + 1] - start);
      }
      runs.push({ start, bits });
      i = k + 1;
    }
    return runs;
  }

  /** Uncapped surprisal of each chunk (for reference comparisons). */
  chunkSurprisal(): Float64Array {
    return this.chunkBits.slice();
  }
}
