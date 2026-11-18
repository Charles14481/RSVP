/// <reference lib="webworker" />
import { AutoModelForCausalLM, AutoTokenizer, Tensor, env } from '@huggingface/transformers';
import { AlignmentError, wordInitialIds, type TokenizerLike } from './align';
import { decodeHalfRow, topPredictions } from './logprob';
import { modelSpec, resolveWindow, type Backend, type BackendPreference, type ModelFile } from './models';
import type { FromWorker, ToWorker } from './protocol';
import { DocumentScorer, type ForwardFn } from './scorer';

declare const self: DedicatedWorkerGlobalScope;

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;

type Model = Awaited<ReturnType<typeof AutoModelForCausalLM.from_pretrained>>;

interface Loaded {
  modelId: string;
  backend: Backend;
  dtype: string;
  tokenizer: TokenizerLike;
  model: Model;
}

interface Job {
  id: number;
  priorityWord: number;
  cancelled: boolean;
}

let loading: { modelId: string; backend: BackendPreference; promise: Promise<Loaded> } | null = null;

/** Word-initial token ids per model, built on first use (decodes the whole vocabulary once). */
const boundaryCache = new Map<string, Int32Array>();
function boundaryIdsFor(loaded: Loaded): Int32Array {
  let ids = boundaryCache.get(loaded.modelId);
  if (!ids) {
    const vocab = (loaded.model as unknown as { config?: { vocab_size?: number } }).config?.vocab_size ?? 50257;
    ids = wordInitialIds(loaded.tokenizer, vocab);
    boundaryCache.set(loaded.modelId, ids);
  }
  return ids;
}
let job: Job | null = null;

/** The last document aligned, kept so a prediction does not re-tokenize the whole text. */
let lastDoc: { text: string; modelId: string; scorer: DocumentScorer } | null = null;

/**
 * Model calls run one at a time. A prediction can arrive while a scoring job is
 * between windows; ONNX Runtime sessions do not take overlapping runs.
 */
let gate: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = gate.then(fn, fn);
  gate = run.catch(() => {});
  return run;
}

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

interface GpuAdapterLike {
  features: { has(name: string): boolean };
}
interface GpuLike {
  requestAdapter(): Promise<GpuAdapterLike | null>;
}

async function webgpuAdapter(): Promise<GpuAdapterLike | null> {
  const gpu = (navigator as unknown as { gpu?: GpuLike }).gpu;
  if (!gpu) return null;
  try {
    return await gpu.requestAdapter();
  } catch {
    return null;
  }
}

function makeForward(model: Model): ForwardFn {
  return async (ids) => {
    const n = ids.length;
    const input_ids = new Tensor('int64', BigInt64Array.from(ids, (v) => BigInt(v)), [1, n]);
    const attention_mask = new Tensor('int64', new BigInt64Array(n).fill(1n), [1, n]);
    const out = (await exclusive(() => model({ input_ids, attention_mask }))) as Record<string, Tensor>;
    return {
      logits: out.logits as unknown as { data: ArrayLike<number>; dims: number[]; type: string },
      release: () => {
        for (const t of Object.values(out)) void t?.dispose?.();
        void input_ids.dispose();
        void attention_mask.dispose();
      },
    };
  };
}

/** A short forward pass to catch backends that load but produce garbage (e.g. fp16 overflow). */
async function warmUp(model: Model, tokenizer: TokenizerLike): Promise<void> {
  const ids = Int32Array.from([tokenizer.bos_token_id ?? 50256, ...tokenizer.encode('The quick brown fox jumps.')]);
  const result = await makeForward(model)(ids);
  try {
    const data = result.logits.data;
    for (let i = 0; i < data.length; i += 97) {
      if (!Number.isFinite(data[i])) throw new Error('model produced non-finite logits');
    }
  } finally {
    result.release();
  }
}

async function loadModel(modelId: string, preference: BackendPreference): Promise<Loaded> {
  const spec = modelSpec(modelId);
  const tokenizer = (await AutoTokenizer.from_pretrained(modelId)) as unknown as TokenizerLike;

  const attempts: { backend: Backend; file: ModelFile }[] = [];
  if (preference === 'auto') {
    const adapter = await webgpuAdapter();
    if (adapter) {
      if (adapter.features.has('shader-f16')) attempts.push({ backend: 'webgpu', file: spec.webgpuFp16 });
      attempts.push({ backend: 'webgpu', file: spec.webgpuFp32 });
    }
  }
  attempts.push({ backend: 'wasm', file: spec.wasm });

  let lastProgress = 0;
  const progress_callback = (info: { status: string; loaded?: number; total?: number }) => {
    if (info.status !== 'progress_total') return;
    const now = performance.now();
    if (now - lastProgress < 100 && info.loaded !== info.total) return;
    lastProgress = now;
    post({ type: 'load-progress', modelId, loaded: info.loaded ?? 0, total: info.total ?? 0 });
  };

  const failures: string[] = [];
  for (const { backend, file } of attempts) {
    let model: Model | null = null;
    try {
      model = await AutoModelForCausalLM.from_pretrained(modelId, {
        device: backend,
        dtype: file.dtype,
        model_file_name: file.file,
        progress_callback,
      } as Parameters<typeof AutoModelForCausalLM.from_pretrained>[1]);
      await warmUp(model, tokenizer);
      const note = failures.length ? `Fell back to ${backend} ${file.dtype}: ${failures.join('; ')}` : undefined;
      return { modelId, backend, dtype: file.dtype, tokenizer, model, ...(note ? { note } : {}) };
    } catch (e) {
      failures.push(`${backend} ${file.dtype}: ${e instanceof Error ? e.message : String(e)}`);
      if (model) await model.dispose().catch(() => {});
    }
  }
  throw new Error(failures.join('\n'));
}

function ensureModel(modelId: string, backend: BackendPreference): Promise<Loaded> {
  if (loading && loading.modelId === modelId && loading.backend === backend) return loading.promise;
  const previous = loading;
  const promise = (async () => {
    if (previous) {
      const old = await previous.promise.catch(() => null);
      await old?.model.dispose().catch(() => {});
    }
    return loadModel(modelId, backend);
  })();
  loading = { modelId, backend, promise };
  promise.then(
    (l) => {
      if (loading?.promise !== promise) return;
      const spec = modelSpec(modelId);
      post({
        type: 'ready',
        modelId,
        backend: l.backend,
        dtype: l.dtype,
        window: resolveWindow(spec, l.backend),
        ...('note' in l && typeof l.note === 'string' ? { note: l.note } : {}),
      });
    },
    (e) => {
      if (loading?.promise !== promise) return;
      loading = null;
      post({ type: 'load-error', modelId, message: e instanceof Error ? e.message : String(e) });
    },
  );
  return promise;
}

async function runJob(msg: Extract<ToWorker, { type: 'score' }>): Promise<void> {
  if (job) job.cancelled = true;
  const current: Job = { id: msg.jobId, priorityWord: msg.priorityWord, cancelled: false };
  job = current;

  if (!loading) {
    post({ type: 'job-error', jobId: msg.jobId, kind: 'other', message: 'No model has been requested.' });
    return;
  }
  let loaded: Loaded;
  try {
    loaded = await loading.promise;
  } catch {
    return; // load-error was already reported
  }
  if (current.cancelled) return;

  let scorer: DocumentScorer;
  try {
    const boundaryIds = msg.boundary ? boundaryIdsFor(loaded) : undefined;
    scorer = new DocumentScorer(loaded.tokenizer, msg.text, { verifyText: import.meta.env.DEV, boundaryIds });
  } catch (e) {
    if (e instanceof AlignmentError) {
      post({ type: 'job-error', jobId: msg.jobId, kind: 'alignment', message: e.message, detail: e.detail });
    } else {
      post({ type: 'job-error', jobId: msg.jobId, kind: 'other', message: String(e) });
    }
    return;
  }
  lastDoc = { text: msg.text, modelId: loaded.modelId, scorer };
  if (msg.known) scorer.markKnown(msg.known);
  post({ type: 'job-started', jobId: msg.jobId, words: scorer.words.length, tokens: scorer.tokenCount });

  const t0 = performance.now();
  const { window, stride } = resolveWindow(modelSpec(loaded.modelId), loaded.backend, msg.window);
  try {
    const status = await scorer.run({
      forward: makeForward(loaded.model),
      window,
      stride,
      priority: () => current.priorityWord,
      cancelled: () => current.cancelled,
      onScores: (runs) => {
        post({ type: 'scores', jobId: current.id, runs }, runs.map((r) => r.bits.buffer));
      },
    });
    if (status === 'complete') post({ type: 'job-done', jobId: current.id, ms: performance.now() - t0 });
  } catch (e) {
    if (current.cancelled) return;
    post({ type: 'job-error', jobId: current.id, kind: 'inference', message: e instanceof Error ? e.message : String(e) });
  } finally {
    if (job === current) job = null;
  }
}

/** The model's top next tokens just before a word, from one forward pass over the preceding window. */
async function predict(msg: Extract<ToWorker, { type: 'predict' }>): Promise<void> {
  const fail = (e: unknown) =>
    post({ type: 'prediction-error', reqId: msg.reqId, message: e instanceof Error ? e.message : String(e) });
  if (!loading) return fail('No model has been requested.');
  try {
    const loaded = await loading.promise;
    if (lastDoc?.text !== msg.text || lastDoc.modelId !== loaded.modelId) {
      lastDoc = { text: msg.text, modelId: loaded.modelId, scorer: new DocumentScorer(loaded.tokenizer, msg.text) };
    }
    const doc = lastDoc.scorer;
    const all = doc.alignment.ids;
    // The word's first token, predicted from the row of the token before it.
    const s = doc.tokenOfWord(msg.word);
    const { window } = resolveWindow(modelSpec(loaded.modelId), loaded.backend, msg.window);
    const ids = all.subarray(Math.max(0, s - window), s);
    const result = await makeForward(loaded.model)(ids);
    try {
      const { data, dims, type } = result.logits;
      const V = dims[dims.length - 1];
      let row: ArrayLike<number> = data;
      let offset = (ids.length - 1) * V;
      if (type === 'float16' && data instanceof Uint16Array) {
        row = decodeHalfRow(data, offset, V, new Float32Array(V));
        offset = 0;
      }
      const target = all[s];
      const { top, target: t } = topPredictions(row, offset, V, msg.k, target);
      const text = (id: number) => loaded.tokenizer.decode([id], { clean_up_tokenization_spaces: false });
      post({
        type: 'prediction',
        reqId: msg.reqId,
        prediction: {
          guesses: top.map((g) => ({ ...g, text: text(g.id) })),
          actual: { id: target, text: text(target), p: t.p, rank: t.rank },
          context: ids.length,
        },
      });
    } finally {
      result.release();
    }
  } catch (e) {
    fail(e);
  }
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'load':
      if (job) job.cancelled = true;
      void ensureModel(msg.modelId, msg.backend);
      break;
    case 'score':
      void runJob(msg);
      break;
    case 'predict':
      void predict(msg);
      break;
    case 'priority':
      if (job?.id === msg.jobId) job.priorityWord = msg.word;
      break;
    case 'cancel':
      if (job?.id === msg.jobId) job.cancelled = true;
      break;
  }
};
