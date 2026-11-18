import { endsPhrase } from '../timing/timing';
import type { Word } from '../types';

/** Longest phrase, in characters, shown at once for each group size. */
export function maxPhraseChars(size: number): number {
  return 6 + 7 * size;
}

/**
 * End (exclusive) of the group of words shown together starting at word i:
 * up to `size` words, never past a word that ends a clause, sentence or
 * paragraph, and never longer than maxPhraseChars(size) unless a single word
 * is. Groups are formed greedily from wherever reading starts.
 */
export function groupEnd(words: readonly Word[], i: number, size: number): number {
  const n = words.length;
  if (i >= n) return n;
  const limit = maxPhraseChars(size);
  let end = i + 1;
  let chars = words[i].text.length;
  while (end < n && end - i < size && !endsPhrase(words[end - 1])) {
    const w = words[end];
    const next = chars + (w.glued ? 0 : 1) + w.text.length;
    if (next > limit) break;
    chars = next;
    end++;
  }
  return end;
}

/** The words [i, end) as one line of text. */
export function groupText(words: readonly Word[], i: number, end: number): string {
  let text = words[i]?.text ?? '';
  for (let k = i + 1; k < end; k++) text += (words[k].glued ? '' : ' ') + words[k].text;
  return text;
}
