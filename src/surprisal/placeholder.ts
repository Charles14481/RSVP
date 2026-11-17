import type { Word } from '../types';

/**
 * Milestone 1 stand-in for the language model: a deterministic value that
 * grows with word length plus a little hash noise. Replaced by the surprisal
 * worker in milestone 2.
 */
export function placeholderSurprisal(words: readonly Word[]): Float32Array {
  const out = new Float32Array(words.length);
  for (let i = 0; i < words.length; i++) {
    const text = words[i].text;
    let h = 2166136261;
    for (let k = 0; k < text.length; k++) h = Math.imul(h ^ text.charCodeAt(k), 16777619);
    const noise = ((h >>> 0) % 500) / 100;
    out[i] = Math.min(20, 1 + 0.9 * text.length + noise);
  }
  return out;
}

export const PLACEHOLDER_MEAN_BITS = 7.5;
