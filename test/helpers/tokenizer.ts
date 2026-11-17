import { fileURLToPath } from 'node:url';
import { AutoTokenizer, env } from '@huggingface/transformers';
import type { TokenizerLike } from '../../src/surprisal/align';

const MODELS_DIR = fileURLToPath(new URL('../fixtures/models/', import.meta.url));

let cached: Promise<TokenizerLike> | null = null;

/** The GPT-2 tokenizer from the vendored fixture files; no network needed. */
export function gpt2Tokenizer(): Promise<TokenizerLike> {
  if (!cached) {
    env.localModelPath = MODELS_DIR;
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    cached = AutoTokenizer.from_pretrained('Xenova/gpt2') as unknown as Promise<TokenizerLike>;
  }
  return cached;
}
