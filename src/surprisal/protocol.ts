import type { Backend, BackendPreference, WindowConfig } from './models';

export type ToWorker =
  | { type: 'load'; modelId: string; backend: BackendPreference }
  | {
      type: 'score';
      jobId: number;
      /** Normalized text; the worker segments it with the same code as the main thread. */
      text: string;
      /** Display-word surprisal already known from the cache (NaN = unknown). */
      known?: Float32Array;
      priorityWord: number;
      window?: Partial<WindowConfig>;
      /** Boundary-corrected word surprisal. */
      boundary?: boolean;
    }
  | {
      type: 'predict';
      reqId: number;
      /** Normalized document text; the worker keeps the last one aligned. */
      text: string;
      /** Display word whose preceding context is asked about. */
      word: number;
      k: number;
      window?: Partial<WindowConfig>;
    }
  | { type: 'priority'; jobId: number; word: number }
  | { type: 'cancel'; jobId: number };

export interface WireRun {
  start: number;
  bits: Float32Array;
}

export interface Guess {
  id: number;
  /** The token as decoded, with its leading space if it has one. */
  text: string;
  p: number;
}

/** What the model expected just before a word: its top next tokens, and how the actual first token ranked. */
export interface Prediction {
  guesses: Guess[];
  actual: Guess & { rank: number };
  /** Tokens of context the prediction saw. */
  context: number;
}

export type JobErrorKind = 'alignment' | 'inference' | 'other';

export type FromWorker =
  | { type: 'load-progress'; modelId: string; loaded: number; total: number }
  | { type: 'ready'; modelId: string; backend: Backend; dtype: string; window: WindowConfig; note?: string }
  | { type: 'load-error'; modelId: string; message: string }
  | { type: 'job-started'; jobId: number; words: number; tokens: number }
  | { type: 'scores'; jobId: number; runs: WireRun[] }
  | { type: 'job-done'; jobId: number; ms: number }
  | { type: 'prediction'; reqId: number; prediction: Prediction }
  | { type: 'prediction-error'; reqId: number; message: string }
  | {
      type: 'job-error';
      jobId: number;
      kind: JobErrorKind;
      message: string;
      detail?: { chunkIndex: number; expected?: string; actual?: string };
    };
