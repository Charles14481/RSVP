/** Logits as they come out of the model: float32, or float16 as raw bits or Float16Array. */
export interface LogitsTensor {
  data: ArrayLike<number>;
  dims: readonly number[];
  type: string;
}

let HALF_TABLE: Float32Array | null = null;

/** IEEE 754 half-precision bits to number, through a 64k lookup table. */
function halfTable(): Float32Array {
  if (HALF_TABLE) return HALF_TABLE;
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const sign = h & 0x8000 ? -1 : 1;
    const exp = (h >> 10) & 0x1f;
    const frac = h & 0x3ff;
    if (exp === 0) t[h] = sign * frac * 2 ** -24;
    else if (exp === 31) t[h] = frac ? NaN : sign * Infinity;
    else t[h] = sign * (1 + frac / 1024) * 2 ** (exp - 15);
  }
  return (HALF_TABLE = t);
}

/**
 * Log-probabilities (natural log) of each target under its logits row.
 * `rows[k]` is the row index in a [1, R, V] logits tensor and `targets[k]` the
 * token id it should predict. Raw float16 bits are decoded row by row.
 */
export function targetLogProbs(logits: LogitsTensor, rows: ArrayLike<number>, targets: ArrayLike<number>): Float64Array {
  return scoreRows(logits, rows, targets, null, null).logp;
}

/**
 * For each requested row: the log-probability of its target and, where
 * `needSet[k]` is set, the log of the total probability of the token ids in
 * `set` (the word-initial tokens, for boundary correction). Natural logs.
 */
export function scoreRows(
  logits: LogitsTensor,
  rows: ArrayLike<number>,
  targets: ArrayLike<number>,
  set: Int32Array | null,
  needSet: ArrayLike<number> | null,
): { logp: Float64Array; setLog: Float64Array } {
  const V = logits.dims[logits.dims.length - 1];
  const logp = new Float64Array(rows.length);
  const setLog = new Float64Array(rows.length).fill(NaN);
  const raw = logits.type === 'float16' && logits.data instanceof Uint16Array ? logits.data : null;
  const scratch = raw ? new Float32Array(V) : null;
  for (let k = 0; k < rows.length; k++) {
    let data: ArrayLike<number> = logits.data;
    let offset = rows[k] * V;
    if (raw) {
      data = decodeHalfRow(raw, offset, V, scratch!);
      offset = 0;
    }
    let max = -Infinity;
    for (let i = 0; i < V; i++) {
      const v = data[offset + i];
      if (v > max) max = v;
    }
    let sum = 0;
    for (let i = 0; i < V; i++) sum += Math.exp(data[offset + i] - max);
    const logSum = Math.log(sum);
    logp[k] = data[offset + targets[k]] - max - logSum;
    if (set && needSet?.[k]) {
      let s = 0;
      for (let i = 0; i < set.length; i++) s += Math.exp(data[offset + set[i]] - max);
      setLog[k] = Math.log(s) - logSum;
    }
  }
  return { logp, setLog };
}

/**
 * Natural-log probability of `target` under softmax(row), where the row is
 * data[offset .. offset + V). Numerically stable log-sum-exp.
 */
export function rowLogProb(data: ArrayLike<number>, offset: number, V: number, target: number): number {
  let max = -Infinity;
  for (let k = 0; k < V; k++) {
    const v = data[offset + k];
    if (v > max) max = v;
  }
  let sum = 0;
  for (let k = 0; k < V; k++) sum += Math.exp(data[offset + k] - max);
  return data[offset + target] - max - Math.log(sum);
}

/**
 * The k most probable token ids under softmax(row), most probable first, and
 * the probability and 1-based rank of `target`. The row is data[offset .. offset + V).
 */
export function topPredictions(
  data: ArrayLike<number>,
  offset: number,
  V: number,
  k: number,
  target: number,
): { top: { id: number; p: number }[]; target: { p: number; rank: number } } {
  let max = -Infinity;
  for (let i = 0; i < V; i++) {
    const v = data[offset + i];
    if (v > max) max = v;
  }
  let sum = 0;
  for (let i = 0; i < V; i++) sum += Math.exp(data[offset + i] - max);
  // Insertion into a sorted list of at most k: cheap for small k over a 50k vocabulary.
  const ids: number[] = [];
  const vals: number[] = [];
  for (let i = 0; i < V && k > 0; i++) {
    const v = data[offset + i];
    if (ids.length === k && v <= vals[k - 1]) continue;
    if (ids.length < k) {
      ids.push(0);
      vals.push(0);
    }
    let j = ids.length - 1;
    while (j > 0 && vals[j - 1] < v) {
      ids[j] = ids[j - 1];
      vals[j] = vals[j - 1];
      j--;
    }
    ids[j] = i;
    vals[j] = v;
  }
  const tv = data[offset + target];
  let rank = 1;
  for (let i = 0; i < V; i++) if (data[offset + i] > tv) rank++;
  return {
    top: ids.map((id, n) => ({ id, p: Math.exp(vals[n] - max) / sum })),
    target: { p: Math.exp(tv - max) / sum, rank },
  };
}

/** Copy one row of raw float16 bits into a float32 scratch buffer. */
export function decodeHalfRow(raw: Uint16Array, offset: number, V: number, out: Float32Array): Float32Array {
  const table = halfTable();
  for (let k = 0; k < V; k++) out[k] = table[raw[offset + k]];
  return out;
}

export const LOG2E = Math.LOG2E;
