import type { FromWorker, ToWorker } from '../surprisal/protocol';
import type { PortLike } from './connection';
import type { FromBackground, ToBackground } from './protocol';

/** The parts of Worker the relay uses. */
export interface RelayWorker {
  postMessage(msg: ToWorker): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
}

export interface RelayDeps {
  createWorker(): RelayWorker;
  loadCache(text: string, key: string, words: number): Promise<{ hash: string; bits: Float32Array | null; position: number }>;
  saveCache(hash: string, key: string, bits: Float32Array): Promise<void>;
  savePosition(hash: string, index: number): Promise<void>;
}

/** How long a worker whose page closed is kept, model loaded, for the next page. */
export const SPARE_MS = 5 * 60_000;

/**
 * Background side: one scoring worker per connected page (a worker runs one
 * job at a time). When a page goes away its worker is cancelled and kept as a
 * warm spare for a while, so the next page skips loading the model.
 */
export class Relay {
  private spare: { worker: RelayWorker; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(private readonly deps: RelayDeps) {}

  attach(port: PortLike): void {
    let worker: RelayWorker | null = null;
    let lastJob: number | null = null;
    let open = true;
    const reply = (msg: FromBackground) => {
      if (!open) return;
      try {
        port.postMessage(msg);
      } catch {
        // the page went away
      }
    };
    const getWorker = (): RelayWorker => {
      if (worker) return worker;
      const w = this.takeSpare() ?? this.deps.createWorker();
      w.onmessage = (e) => reply({ type: 'worker', msg: e.data });
      w.onerror = (e) => {
        e.preventDefault?.();
        reply({ type: 'worker-error', message: e.message || 'The scoring worker crashed.' });
      };
      worker = w;
      return w;
    };

    port.onMessage.addListener(((msg: ToBackground) => {
      switch (msg.type) {
        case 'worker':
          if (msg.msg.type === 'score') lastJob = msg.msg.jobId;
          getWorker().postMessage(msg.msg);
          break;
        case 'cache-load':
          this.deps.loadCache(msg.text, msg.key, msg.words).then(
            (entry) => reply({ type: 'cache', reqId: msg.reqId, ...entry }),
            () => reply({ type: 'cache', reqId: msg.reqId, hash: '', bits: null, position: 0 }),
          );
          break;
        case 'cache-save':
          void this.deps.saveCache(msg.hash, msg.key, msg.bits).catch(() => {});
          break;
        case 'position-save':
          void this.deps.savePosition(msg.hash, msg.index).catch(() => {});
          break;
        case 'ping':
          break;
      }
    }) as (msg: never) => void);

    port.onDisconnect.addListener((() => {
      open = false;
      if (!worker) return;
      if (lastJob !== null) worker.postMessage({ type: 'cancel', jobId: lastJob });
      worker.onmessage = null;
      worker.onerror = null;
      this.keepSpare(worker);
      worker = null;
    }) as (port: never) => void);
  }

  private takeSpare(): RelayWorker | null {
    const s = this.spare;
    if (!s) return null;
    clearTimeout(s.timer);
    this.spare = null;
    return s.worker;
  }

  private keepSpare(worker: RelayWorker): void {
    this.takeSpare()?.terminate();
    const timer = setTimeout(() => {
      if (this.spare?.worker === worker) this.spare = null;
      worker.terminate();
    }, SPARE_MS);
    this.spare = { worker, timer };
  }
}
