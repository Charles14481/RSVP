import type { ReaderSession } from '../player/session';
import type { Backend, BackendPreference, WindowConfig } from './models';
import type { FromWorker, JobErrorKind, ToWorker } from './protocol';

export type ModelStatus =
  | { phase: 'idle' }
  | { phase: 'loading'; modelId: string; loaded: number; total: number }
  | { phase: 'ready'; modelId: string; backend: Backend; dtype: string; window: WindowConfig; note?: string }
  | { phase: 'error'; modelId: string; message: string };

export type JobStatus =
  | { phase: 'waiting' }
  | { phase: 'scoring'; words: number; tokens: number }
  | { phase: 'done'; ms: number }
  | { phase: 'error'; kind: JobErrorKind; message: string };

export interface ScoreRequest {
  priorityWord: number;
  known?: Float32Array;
  window?: Partial<WindowConfig>;
  /** Called after each batch lands in the session (e.g. to persist the cache). */
  onProgress?: () => void;
  onDone?: () => void;
}

/**
 * Main-thread handle on the surprisal worker. Holds the model and job status
 * for React (useSyncExternalStore) and routes streamed scores into the
 * current ReaderSession.
 */
export class SurprisalService {
  private worker: Worker | null = null;
  private listeners = new Set<() => void>();
  private nextJobId = 1;
  private current: { id: number; session: ReaderSession; request: ScoreRequest } | null = null;
  private wanted: { modelId: string; backend: BackendPreference } | null = null;
  private snapshot: { model: ModelStatus; job: JobStatus | null } = { model: { phase: 'idle' }, job: null };

  get model(): ModelStatus {
    return this.snapshot.model;
  }

  get job(): JobStatus | null {
    return this.snapshot.job;
  }

  /** Stable between changes, for useSyncExternalStore. */
  getSnapshot = () => this.snapshot;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Load a model unless it is already loaded or loading. */
  load(modelId: string, backend: BackendPreference = 'auto', force = false): void {
    const m = this.snapshot.model;
    const same = this.wanted?.modelId === modelId && this.wanted.backend === backend;
    if (same && !force && m.phase !== 'error') return;
    this.wanted = { modelId, backend };
    this.set({ model: { phase: 'loading', modelId, loaded: 0, total: 0 } });
    this.send({ type: 'load', modelId, backend });
    // A model switch cancels the job in the worker; restart it on the new model.
    if (this.current) this.restart();
  }

  /** Start scoring a session, replacing any previous job. */
  score(session: ReaderSession, request: ScoreRequest): void {
    this.cancel();
    const id = this.nextJobId++;
    this.current = { id, session, request };
    this.set({ job: { phase: 'waiting' } });
    if (session.complete) {
      this.set({ job: { phase: 'done', ms: 0 } });
      return;
    }
    const known = request.known ?? (session.scoredCount ? session.surprisal.slice() : undefined);
    this.send({ type: 'score', jobId: id, text: session.text, priorityWord: request.priorityWord, known, window: request.window });
  }

  /** Score from this word onward next (after a seek into unscored text). */
  prioritize(word: number): void {
    if (this.current) {
      this.current.request.priorityWord = word;
      this.send({ type: 'priority', jobId: this.current.id, word });
    }
  }

  cancel(): void {
    if (this.current) this.send({ type: 'cancel', jobId: this.current.id });
    this.current = null;
    if (this.snapshot.job) this.set({ job: null });
  }

  /** Rescore the current session from what it already has (after a model or window change). */
  restart(request?: Partial<ScoreRequest>): void {
    const cur = this.current;
    if (!cur) return;
    this.score(cur.session, { ...cur.request, ...request, known: undefined });
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'surprisal' });
      this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data);
      this.worker.onerror = (e) => {
        const modelId = this.wanted?.modelId ?? '';
        this.set({ model: { phase: 'error', modelId, message: e.message || 'The scoring worker crashed.' } });
      };
    }
    return this.worker;
  }

  private send(msg: ToWorker): void {
    this.ensureWorker().postMessage(msg);
  }

  private onMessage(msg: FromWorker): void {
    switch (msg.type) {
      case 'load-progress':
        if (this.wanted?.modelId === msg.modelId) {
          this.set({ model: { phase: 'loading', modelId: msg.modelId, loaded: msg.loaded, total: msg.total } });
        }
        return;
      case 'ready':
        if (this.wanted?.modelId === msg.modelId) {
          const { type: _, ...rest } = msg;
          this.set({ model: { phase: 'ready', ...rest } });
        }
        return;
      case 'load-error':
        if (this.wanted?.modelId === msg.modelId) {
          this.set({ model: { phase: 'error', modelId: msg.modelId, message: msg.message } });
        }
        return;
    }

    const cur = this.current;
    if (!cur || msg.jobId !== cur.id) return;
    switch (msg.type) {
      case 'job-started':
        this.set({ job: { phase: 'scoring', words: msg.words, tokens: msg.tokens } });
        break;
      case 'scores':
        for (const run of msg.runs) cur.session.applyScores(run.start, run.bits);
        cur.request.onProgress?.();
        break;
      case 'job-done':
        this.set({ job: { phase: 'done', ms: msg.ms } });
        cur.request.onDone?.();
        break;
      case 'job-error':
        this.set({ job: { phase: 'error', kind: msg.kind, message: msg.message } });
        break;
    }
  }

  private set(patch: Partial<{ model: ModelStatus; job: JobStatus | null }>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of this.listeners) fn();
  }
}

let service: SurprisalService | null = null;

export function surprisalService(): SurprisalService {
  return (service ??= new SurprisalService());
}
