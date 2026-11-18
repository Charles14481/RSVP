const ALNUM = /[\p{L}\p{N}]/u;

/** Pivot offset from the first letter, by letter count. */
export function pivotOffset(letterCount: number): number {
  if (letterCount <= 1) return 0;
  if (letterCount <= 5) return 1;
  if (letterCount <= 9) return 2;
  if (letterCount <= 13) return 3;
  return 4;
}

/**
 * Split a word around its optimal recognition point. The pivot is chosen by
 * the number of letters and digits, counted from the first one so leading
 * punctuation does not shift it.
 */
export function splitAtPivot(text: string): { left: string; pivot: string; right: string } {
  const chars = Array.from(text);
  return splitAt(chars, wordPivot(chars));
}

/** Index of the pivot within one word's characters. */
function wordPivot(chars: string[]): number {
  let first = -1;
  let letters = 0;
  for (let i = 0; i < chars.length; i++) {
    if (ALNUM.test(chars[i])) {
      if (first === -1) first = i;
      letters++;
    }
  }
  return first === -1 ? 0 : Math.min(first + pivotOffset(letters), chars.length - 1);
}

function splitAt(chars: string[], at: number): { left: string; pivot: string; right: string } {
  return {
    left: chars.slice(0, at).join(''),
    pivot: chars[at] ?? '',
    right: chars.slice(at + 1).join(''),
  };
}

/**
 * Split a phrase of one or more space-separated words for display. The pivot
 * is the usual one of the word under the middle of the phrase, so the eye
 * lands near its centre on a natural letter. One word splits as splitAtPivot.
 */
export function splitPhrase(text: string): { left: string; pivot: string; right: string } {
  const chars = Array.from(text);
  const mid = (chars.length - 1) / 2;
  let best: { start: number; end: number } | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < chars.length; ) {
    if (chars[i] === ' ') {
      i++;
      continue;
    }
    let j = i;
    while (j < chars.length && chars[j] !== ' ') j++;
    // Distance from the middle to this word's span (0 if the middle is inside it).
    const dist = mid < i ? i - mid : mid > j - 1 ? mid - (j - 1) : 0;
    if (dist < bestDist) {
      best = { start: i, end: j };
      bestDist = dist;
    }
    i = j;
  }
  if (!best) return splitAt(chars, 0);
  return splitAt(chars, best.start + wordPivot(chars.slice(best.start, best.end)));
}
