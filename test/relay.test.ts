import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundConnection, type PortLike } from '../src/extension/connection';
import { Relay, SPARE_MS, type RelayWorker } from '../src/extension/relay';
import type { FromWorker, ToWorker } from '../src/surprisal/protocol';

/** Two connected fake ports, delivering asynchronously with structured clone like runtime.Port. */
function portPair(): [PortLike & { disconnected: boolean }, PortLike & { disconnected: boolean }] {
  const make = () => {
    const msg: ((m: never) => void)[] = [];
    const dis: ((p: never) => void)[] = [];
    return {
      msg,
      dis,
      port: {
        disconnected: false,
        postMessage: (_m: unknown) => {},
        disconnect: () => {},
        onMessage: { addListener: (cb: (m: never) => void) => msg.push(cb) },
        onDisconnect: { addListener: (cb: (p: never) => void) => dis.push(cb) },
      },
    };
  };
  const a = make();
  const b = make();
  const link = (from: typeof a, to: typeof b) => {
    from.port.postMessage = (m: unknown) => {
      if (from.port.disconnected) throw new Error('disconnected');
      const copy = structuredClone(m);
      queueMicrotask(() => to.msg.forEach((cb) => cb(copy as never)));
    };
    from.port.disconnect = () => {
      from.port.disconnected = true;
      to.port.disconnected = true;
      queueMicrotask(() => to.dis.forEach((cb) => cb(to.port as never)));
    };
  };
  link(a, b);
  link(b, a);
  return [a.port, b.port];
}

class FakeWorker implements RelayWorker {
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  received: ToWorker[] = [];
  terminated = false;
  postMessage(msg: ToWorker): void {
    this.received.push(msg);
    if (msg.type === 'score') {
      queueMicrotask(() => this.onmessage?.({ data: { type: 'scores', jobId: msg.jobId, runs: [{ start: 2, bits: Float32Array.from([1.5, 2.5]) }] } } as MessageEvent<FromWorker>));
    }
  }
  terminate(): void {
    this.terminated = true;
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const workers: FakeWorker[] = [];
  const saved: [string, string, Float32Array][] = [];
  const relay = new Relay({
    createWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    loadCache: async (text, _key, words) => ({ hash: `h(${text})`, bits: words === 3 ? Float32Array.from([NaN, 1, 2]) : null, position: 7 }),
    saveCache: async (hash, key, bits) => {
      saved.push([hash, key, bits]);
    },
    savePosition: async () => {},
  });
  const backgrounds: PortLike[] = [];
  const connect = () => {
    const [content, background] = portPair();
    relay.attach(background);
    backgrounds.push(background);
    return content;
  };
  return { relay, workers, saved, connect, backgrounds };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BackgroundConnection + Relay', () => {
  it('relays worker messages both ways, typed arrays intact', async () => {
    const { workers, connect } = setup();
    const conn = new BackgroundConnection(connect);
    const got: FromWorker[] = [];
    conn.onmessage = (e) => got.push(e.data);
    conn.postMessage({ type: 'load', modelId: 'Xenova/gpt2', backend: 'auto' });
    conn.postMessage({ type: 'score', jobId: 1, text: 'a b c', priorityWord: 0 });
    await flush();
    expect(workers).toHaveLength(1);
    expect(workers[0].received.map((m) => m.type)).toEqual(['load', 'score']);
    expect(got).toHaveLength(1);
    const scores = got[0] as Extract<FromWorker, { type: 'scores' }>;
    expect(scores.runs[0].bits).toBeInstanceOf(Float32Array);
    expect(Array.from(scores.runs[0].bits)).toEqual([1.5, 2.5]);
    conn.close();
  });

  it('loads and saves the cache through the background', async () => {
    const { saved, connect } = setup();
    const conn = new BackgroundConnection(connect);
    const entry = await conn.loadCache('a b c', 'Xenova/gpt2', 3);
    expect(entry?.hash).toBe('h(a b c)');
    expect(entry?.position).toBe(7);
    expect(Array.from(entry!.bits!).slice(1)).toEqual([1, 2]);
    conn.saveCache('h', 'k', Float32Array.from([3]));
    await flush();
    expect(saved).toHaveLength(1);
    expect(saved[0][2]).toBeInstanceOf(Float32Array);
    conn.close();
  });

  it('keeps a closed page’s worker as a spare for the next page, then lets it go', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { workers, connect } = setup();
    const first = new BackgroundConnection(connect);
    first.postMessage({ type: 'score', jobId: 4, text: 'x', priorityWord: 0 });
    await Promise.resolve();
    await Promise.resolve();
    first.close();
    await Promise.resolve();
    await Promise.resolve();
    // The job was cancelled and the worker kept.
    expect(workers[0].received.at(-1)).toEqual({ type: 'cancel', jobId: 4 });
    expect(workers[0].terminated).toBe(false);

    const second = new BackgroundConnection(connect);
    second.postMessage({ type: 'load', modelId: 'Xenova/gpt2', backend: 'auto' });
    await Promise.resolve();
    await Promise.resolve();
    expect(workers).toHaveLength(1);
    second.close();
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(SPARE_MS + 1);
    expect(workers[0].terminated).toBe(true);
  });

  it('reports a lost background as a worker error and reconnects on the next message', async () => {
    const { workers, connect, backgrounds } = setup();
    const conn = new BackgroundConnection(connect);
    const errors: string[] = [];
    conn.onerror = (e) => errors.push(e.message);
    conn.postMessage({ type: 'load', modelId: 'Xenova/gpt2', backend: 'auto' });
    await flush();
    // The background goes away (Firefox suspended it): the other end disconnects.
    const pending = conn.loadCache('t', 'k', 1);
    backgrounds[0].disconnect();
    await flush();
    expect(errors).toHaveLength(1);
    expect(await pending).toBeNull();
    conn.postMessage({ type: 'load', modelId: 'Xenova/gpt2', backend: 'auto' });
    await flush();
    expect(backgrounds).toHaveLength(2);
    expect(workers.at(-1)!.received.at(-1)).toEqual({ type: 'load', modelId: 'Xenova/gpt2', backend: 'auto' });
    conn.close();
  });
});
