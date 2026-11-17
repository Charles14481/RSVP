import type { Word } from '../types';

/** Index of the first word of the sentence containing word i. */
export function sentenceStart(words: readonly Word[], i: number): number {
  let j = Math.max(0, Math.min(i, words.length - 1));
  while (j > 0 && !words[j - 1].sentenceEnd) j--;
  return j;
}

/** Start of the next sentence, or the last word if there is none. */
export function nextSentenceStart(words: readonly Word[], i: number): number {
  let j = Math.max(0, i);
  while (j < words.length - 1 && !words[j].sentenceEnd) j++;
  return Math.min(j + 1, words.length - 1);
}

/**
 * Where "previous sentence" should land: the start of the current sentence, or
 * the start of the one before it when already at (or within `slack` words of)
 * the start.
 */
export function previousSentenceStart(words: readonly Word[], i: number, slack = 0): number {
  const start = sentenceStart(words, i);
  if (i - start > slack || start === 0) return start;
  return sentenceStart(words, start - 1);
}

/** Index of the first word of the paragraph containing word i. */
export function paragraphStart(words: readonly Word[], i: number): number {
  let j = Math.max(0, Math.min(i, words.length - 1));
  while (j > 0 && !words[j - 1].paragraphEnd) j--;
  return j;
}

/** Half-open [start, end) range of the paragraph containing word i. */
export function paragraphRange(words: readonly Word[], i: number): [number, number] {
  const start = paragraphStart(words, i);
  let end = Math.max(start, Math.min(i, words.length - 1));
  while (end < words.length - 1 && !words[end].paragraphEnd) end++;
  return [start, Math.min(end + 1, words.length)];
}
