import type { WorkerLike } from '../surprisal/client';
import type { FromWorker, ToWorker } from '../surprisal/protocol';
import { PING_MS, type FromBackground, type ToBackground } from './protocol';

/** The parts of runtime.Port used here, so tests can pass a fake. */
export interface PortLike {
  postMessage(msg: unknown): void;
  disconnect(): void;
  onMessage: { addListener(cb: (msg: never) => void): void };
  onDisconnect: { addListener(cb: (port: never) => void): void };
}

export interface CacheEntry {
  hash: string;
  bits: Float32Array | null;
  position: number;
}

/**
 * The content script's line to the background page. To SurprisalService it
 * looks like the scoring worker: messages are relayed to a real worker in the
 * background, which has the extension's origin (one model download, one cache
 * for every site). It also carries cache reads and writes.
 */
export class BackgroundConnection implements WorkerLike {
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  private port: PortLike | null = null;
  private ping: ReturnType<typeof setInterval> | undefined;
  private nextReq = 1;
  private pending = new Map<number, (entry: CacheEntry | null) => void>();
  private closed = false;

  constructor(private readonly connect: () => PortLike) {}

  postMessage(msg: ToWorker): void {
    this.send({ type: 'worker', msg });
  }

  /** Cached surprisal and saved position for this text (null if the background is unreachable). */
  loadCache(text: string, key: string, words: number): Promise<CacheEntry | null> {
    const reqId = this.nextReq++;
    return new Promise((resolve) => {
      this.pending.set(reqId, resolve);
      try {
        this.send({ type: 'cache-load', reqId, text, key, words });
      } catch {
        this.pending.delete(reqId);
        resolve(null);
      }
    });
  }

  saveCache(hash: string, key: string, bits: Float32Array): void {
    this.trySend({ type: 'cache-save', hash, key, bits: bits.slice() });
  }

  savePosition(hash: string, index: number): void {
    this.trySend({ type: 'position-save', hash, index });
  }

  close(): void {
    this.closed = true;
    const port = this.port;
    this.drop();
    try {
      port?.disconnect();
    } catch {
      // already gone
    }
  }

  private trySend(msg: ToBackground): void {
    try {
      this.send(msg);
    } catch {
      // Best effort: a lost cache write only costs rescoring later.
    }
  }

  private send(msg: ToBackground): void {
    if (this.closed) return;
    this.ensure().postMessage(msg);
  }

  private ensure(): PortLike {
    if (this.port) return this.port;
    const port = this.connect();
    this.port = port;
    port.onMessage.addListener(((msg: FromBackground) => this.receive(msg)) as (msg: never) => void);
    port.onDisconnect.addListener((() => {
      if (this.port !== port) return;
      this.drop();
      if (!this.closed) {
        this.onerror?.({ message: 'Lost the connection to the extension’s background page.' } as ErrorEvent);
      }
    }) as (port: never) => void);
    this.ping = setInterval(() => this.trySend({ type: 'ping' }), PING_MS);
    return port;
  }

  private drop(): void {
    clearInterval(this.ping);
    this.port = null;
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
  }

  private receive(msg: FromBackground): void {
    switch (msg.type) {
      case 'worker':
        this.onmessage?.({ data: msg.msg } as MessageEvent<FromWorker>);
        break;
      case 'worker-error':
        this.onerror?.({ message: msg.message } as ErrorEvent);
        break;
      case 'cache': {
        const resolve = this.pending.get(msg.reqId);
        this.pending.delete(msg.reqId);
        resolve?.({ hash: msg.hash, bits: msg.bits, position: msg.position });
        break;
      }
    }
  }
}
