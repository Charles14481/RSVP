/**
 * Runs the browser scoring core in Node against real GPT-2 weights and
 * compares with the PyTorch reference written by scripts/reference_surprisal.py.
 * Downloads models on first run (cached by Transformers.js afterwards).
 */
import { readFileSync } from 'node:fs';
import { AutoModelForCausalLM, AutoTokenizer, Tensor, env } from '@huggingface/transformers';
import { describe, expect, it } from 'vitest';
import { normalizeText } from '../../src/segment/segment';
import type { TokenizerLike } from '../../src/surprisal/align';
import { DocumentScorer, type ForwardFn } from '../../src/surprisal/scorer';
import { SAMPLE_TEXT } from '../../src/ui/sample';
import { PASSAGES, passage, type PassageName } from '../helpers/fixtures';

env.allowRemoteModels = true;
env.allowLocalModels = false;

interface Reference {
  ids: number[];
  token_bits: (number | null)[];
  words: string[];
  word_bits: number[];
  window: number;
  stride: number;
}

function reference(name: PassageName, model: string): Reference {
  return JSON.parse(readFileSync(new URL(`../fixtures/reference/${name}.${model}.json`, import.meta.url), 'utf8'));
}

type Model = Awaited<ReturnType<typeof AutoModelForCausalLM.from_pretrained>>;

async function load(id: string, dtype: 'fp32' | 'q8', file?: string) {
  const tokenizer = (await AutoTokenizer.from_pretrained(id)) as unknown as TokenizerLike;
  const model = await AutoModelForCausalLM.from_pretrained(id, {
    dtype,
    device: 'cpu',
    ...(file ? { model_file_name: file } : {}),
  } as Parameters<typeof AutoModelForCausalLM.from_pretrained>[1]);
  return { tokenizer, model };
}

function forwardOf(model: Model): ForwardFn {
  return async (ids) => {
    const n = ids.length;
    const out = (await model({
      input_ids: new Tensor('int64', BigInt64Array.from(ids, (v) => BigInt(v)), [1, n]),
      attention_mask: new Tensor('int64', new BigInt64Array(n).fill(1n), [1, n]),
    })) as Record<string, Tensor>;
    return {
      logits: out.logits as unknown as { data: Float32Array; dims: number[]; type: string },
      release: () => Object.values(out).forEach((t) => void t.dispose()),
    };
  };
}

async function scoreText(tokenizer: TokenizerLike, model: Model, text: string, window: number, stride: number) {
  const scorer = new DocumentScorer(tokenizer, text, { verifyText: true });
  const words = new Float32Array(scorer.words.length).fill(NaN);
  await scorer.run({
    forward: forwardOf(model),
    window,
    stride,
    onScores: (runs) => runs.forEach((r) => words.set(r.bits, r.start)),
  });
  return { scorer, words };
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i] / n;
    mb += b[i] / n;
  }
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
}

const mean = (a: ArrayLike<number>) => Array.from(a).reduce((x, y) => x + y, 0) / a.length;

describe.each([
  ['Xenova/gpt2', 'gpt2'],
  ['Xenova/distilgpt2', 'distilgpt2'],
])('%s fp32 against PyTorch', (id, refName) => {
  it.each(PASSAGES)('agrees on %s within 0.01 bits per token', async (name) => {
    const { tokenizer, model } = await load(id, 'fp32');
    const ref = reference(name, refName);
    const { scorer } = await scoreText(tokenizer, model, passage(name), ref.window, ref.stride);

    expect(Array.from(scorer.alignment.ids)).toEqual(ref.ids);
    let maxDiff = 0;
    for (let j = 1; j < ref.ids.length; j++) {
      if (scorer.alignment.groupOf[j] < 0) continue; // newline tokens are not scored
      maxDiff = Math.max(maxDiff, Math.abs(scorer.tokenBits[j] - ref.token_bits[j]!));
    }
    // Words: the app's token-string grouping against the reference's offset-based grouping.
    expect(scorer.chunks).toEqual(ref.words);
    const chunkBits = scorer.chunkSurprisal();
    let maxWordDiff = 0;
    for (let c = 0; c < ref.words.length; c++) maxWordDiff = Math.max(maxWordDiff, Math.abs(chunkBits[c] - ref.word_bits[c]));
    console.log(`${id} ${name}: ${ref.ids.length} tokens, max token diff ${maxDiff.toExponential(2)} bits, max word diff ${maxWordDiff.toExponential(2)} bits`);
    expect(maxDiff).toBeLessThan(0.01);
    expect(maxWordDiff).toBeLessThan(0.03);
    await model.dispose();
  });
});

describe('windowing', () => {
  it('values near window starts stay close to a single full-context pass', async () => {
    const { tokenizer, model } = await load('Xenova/gpt2', 'fp32');
    const text = passage('austen');
    const full = await scoreText(tokenizer, model, text, 1024, 1024);
    expect(full.scorer.tokenCount).toBeLessThanOrEqual(1024);

    const meanDiffs: number[] = [];
    for (const [W, S] of [
      [512, 256],
      [256, 128],
      [128, 64],
    ]) {
      const win = await scoreText(tokenizer, model, text, W, S);
      // Targets with the least context: the first 16 scored in every window after the first.
      const diffs: number[] = [];
      for (let first = W + 1; first < full.scorer.tokenCount; first += S) {
        for (let j = first; j < Math.min(first + 16, full.scorer.tokenCount); j++) {
          if (full.scorer.alignment.groupOf[j] < 0) continue;
          diffs.push(Math.abs(win.scorer.tokenBits[j] - full.scorer.tokenBits[j]));
        }
      }
      const r = pearson(win.words, full.words);
      console.log(`W=${W} S=${S}: mean |diff| at window starts ${mean(diffs).toFixed(3)} bits (n=${diffs.length}), word correlation ${r.toFixed(4)}`);
      // Austen is memorized by GPT-2, so extra context helps more than on ordinary prose.
      expect(mean(diffs)).toBeLessThan(W >= 512 ? 0.25 : 1.0);
      expect(r).toBeGreaterThan(W >= 512 ? 0.99 : W >= 256 ? 0.98 : 0.9);
      meanDiffs.push(mean(diffs));
    }
    // Less context at window starts, larger differences: a windowing bug would break this.
    expect(meanDiffs[0]).toBeLessThan(meanDiffs[1]);
    expect(meanDiffs[1]).toBeLessThan(meanDiffs[2]);
    await model.dispose();
  });
});

describe('quantized browser variants', () => {
  it.each([
    ['Xenova/gpt2', 'gpt2'],
    ['Xenova/distilgpt2', 'distilgpt2'],
  ])('%s 8-bit merged decoder tracks fp32', async (id, refName) => {
    const { tokenizer, model } = await load(id, 'q8', 'decoder_model_merged');
    for (const name of PASSAGES) {
      const ref = reference(name, refName);
      const { scorer } = await scoreText(tokenizer, model, passage(name), ref.window, ref.stride);
      const q = scorer.chunkSurprisal();
      const diffs = ref.word_bits.map((b, c) => Math.abs(q[c] - b));
      const r = pearson(q, ref.word_bits);
      console.log(`${id} q8 ${name}: word correlation ${r.toFixed(4)}, mean |diff| ${mean(diffs).toFixed(2)} bits, mean ${mean(q).toFixed(2)} vs ${mean(ref.word_bits).toFixed(2)}`);
      expect(r).toBeGreaterThan(0.9);
    }
    await model.dispose();
  });
});

describe('mean seed', () => {
  it('measures mean word surprisal on the sample prose', async () => {
    const text = normalizeText(SAMPLE_TEXT);
    for (const id of ['Xenova/gpt2', 'Xenova/distilgpt2']) {
      for (const [dtype, file] of [
        ['fp32', undefined],
        ['q8', 'decoder_model_merged'],
      ] as const) {
        const { tokenizer, model } = await load(id, dtype, file);
        const { words } = await scoreText(tokenizer, model, text, 512, 256);
        console.log(`${id} ${dtype}: mean ${mean(words).toFixed(2)} bits over ${words.length} words`);
        await model.dispose();
      }
    }
  });
});
