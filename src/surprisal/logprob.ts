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
  const V = logits.dims[logits.dims.length - 1];
  const out = new Float64Array(rows.length);
  const raw = logits.type === 'float16' && logits.data instanceof Uint16Array ? logits.data : null;
  const scratch = raw ? new Float32Array(V) : null;
  for (let k = 0; k < rows.length; k++) {
    const offset = rows[k] * V;
    out[k] = raw
      ? rowLogProb(decodeHalfRow(raw, offset, V, scratch!), 0, V, targets[k])
      : rowLogProb(logits.data, offset, V, targets[k]);
  }
  return out;
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

/** Copy one row of raw float16 bits into a float32 scratch buffer. */
export function decodeHalfRow(raw: Uint16Array, offset: number, V: number, out: Float32Array): Float32Array {
  const table = halfTable();
  for (let k = 0; k < V; k++) out[k] = table[raw[offset + k]];
  return out;
}

export const LOG2E = Math.LOG2E;
