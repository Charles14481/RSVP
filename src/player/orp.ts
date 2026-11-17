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
  let first = -1;
  let letters = 0;
  for (let i = 0; i < chars.length; i++) {
    if (ALNUM.test(chars[i])) {
      if (first === -1) first = i;
      letters++;
    }
  }
  const at = first === -1 ? 0 : Math.min(first + pivotOffset(letters), chars.length - 1);
  return {
    left: chars.slice(0, at).join(''),
    pivot: chars[at] ?? '',
    right: chars.slice(at + 1).join(''),
  };
}
