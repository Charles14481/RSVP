/**
 * Token-to-word alignment by token strings. Transformers.js tokenizers do not
 * expose offset mappings, so each token is decoded on its own and grouped:
 *
 * - a token whose string starts with a space begins a new word;
 * - so does the first non-whitespace token after a whitespace-only token
 *   (a newline), after a skipped special token (BOS), or at the very start;
 * - whitespace-only tokens belong to no word.
 *
 * Invariant (see verifyAlignment): the number of groups equals the number of
 * whitespace-delimited chunks, and decoding each group's ids together, trimmed,
 * gives that chunk's text exactly.
 */

export interface TokenizerLike {
  encode(text: string, options?: { add_special_tokens?: boolean }): number[];
  decode(ids: number[], options?: { skip_special_tokens?: boolean; clean_up_tokenization_spaces?: boolean }): string;
  bos_token_id?: number | null;
  eos_token_id?: number | null;
}

export interface Alignment {
  /** Token ids with BOS at index 0. */
  ids: Int32Array;
  /** Group (chunk) index for each token, -1 for BOS and whitespace-only tokens. */
  groupOf: Int32Array;
  /** Tokens of group g are ids[groupStart[g] .. groupEnd[g]). */
  groupStart: Int32Array;
  groupEnd: Int32Array;
  groupCount: number;
}

const WHITESPACE_ONLY = /^\s+$/;
const DECODE_OPTS = { skip_special_tokens: false, clean_up_tokenization_spaces: false } as const;

/** Decodes single ids with a cache; the vocabulary is small and ids repeat a lot. */
export function pieceDecoder(tokenizer: TokenizerLike): (id: number) => string {
  const cache = new Map<number, string>();
  return (id) => {
    let s = cache.get(id);
    if (s === undefined) {
      s = tokenizer.decode([id], DECODE_OPTS);
      cache.set(id, s);
    }
    return s;
  };
}

/** Group tokens into words by the rules above. `skip[i]` marks special tokens. */
export function groupTokens(
  pieces: readonly string[],
  skip: (i: number) => boolean = () => false,
): Pick<Alignment, 'groupOf' | 'groupStart' | 'groupEnd' | 'groupCount'> {
  const groupOf = new Int32Array(pieces.length).fill(-1);
  const starts: number[] = [];
  const ends: number[] = [];
  let afterBreak = true;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (skip(i) || piece.length === 0 || WHITESPACE_ONLY.test(piece)) {
      afterBreak = true;
      continue;
    }
    if (afterBreak || piece.charCodeAt(0) === 0x20) {
      starts.push(i);
      ends.push(i + 1);
    }
    afterBreak = false;
    const g = starts.length - 1;
    groupOf[i] = g;
    ends[g] = i + 1;
  }
  return {
    groupOf,
    groupStart: Int32Array.from(starts),
    groupEnd: Int32Array.from(ends),
    groupCount: starts.length,
  };
}

/** Encode normalized text with BOS prepended and group its tokens. */
export function alignText(tokenizer: TokenizerLike, text: string): Alignment {
  const bos = tokenizer.bos_token_id ?? tokenizer.eos_token_id;
  if (bos == null) throw new Error('Tokenizer has no BOS or EOS token to condition the first word on.');
  const body = tokenizer.encode(text, { add_special_tokens: false });
  const ids = new Int32Array(body.length + 1);
  ids[0] = bos;
  ids.set(body, 1);
  const piece = pieceDecoder(tokenizer);
  const pieces = Array.from(ids, (id) => piece(id));
  return { ids, ...groupTokens(pieces, (i) => i === 0) };
}

export class AlignmentError extends Error {
  constructor(
    message: string,
    readonly detail: { chunkIndex: number; expected?: string; actual?: string },
  ) {
    super(message);
    this.name = 'AlignmentError';
  }
}

/**
 * Check the invariant. With `checkText` false only the counts are compared,
 * which is cheap enough for every production run; the full check decodes
 * every group and runs in tests and dev builds.
 */
export function verifyAlignment(
  al: Alignment,
  chunks: readonly string[],
  tokenizer: TokenizerLike,
  checkText = true,
): void {
  const groupText = (g: number) =>
    tokenizer.decode(Array.from(al.ids.subarray(al.groupStart[g], al.groupEnd[g])), DECODE_OPTS).trim();

  if (checkText || al.groupCount !== chunks.length) {
    const n = Math.min(al.groupCount, chunks.length);
    for (let c = 0; c < n; c++) {
      const actual = groupText(c);
      if (actual !== chunks[c]) {
        throw new AlignmentError(
          `Token groups do not match words at word ${c}: expected ${JSON.stringify(chunks[c])}, got ${JSON.stringify(actual)}.`,
          { chunkIndex: c, expected: chunks[c], actual },
        );
      }
    }
  }
  if (al.groupCount !== chunks.length) {
    const c = Math.min(al.groupCount, chunks.length);
    throw new AlignmentError(
      `Found ${al.groupCount} token groups for ${chunks.length} words; the first unmatched word is ${c}.`,
      { chunkIndex: c, expected: chunks[c], actual: c < al.groupCount ? groupText(c) : undefined },
    );
  }
}
