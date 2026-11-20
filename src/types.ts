/** One unit shown by the RSVP display. */
export interface Word {
  index: number;
  text: string;
  paragraphIndex: number;
  sentenceEnd: boolean;
  paragraphEnd: boolean;
  /**
   * True when this word continues the previous one with no whitespace between
   * them: a long chunk (URL, long compound) that was split for display. The
   * language model still sees the unsplit chunk.
   */
  glued?: boolean;
}

/**
 * Per-word surprisal in bits, parallel to Word[]. NaN means "not scored yet".
 * Kept as a typed array (rather than a field on each Word) so windows of
 * results can be streamed from the worker and cached without copying objects.
 */
export type Surprisal = Float32Array;

export function newSurprisal(wordCount: number): Surprisal {
  return new Float32Array(wordCount).fill(NaN);
}

/** Inline style bits of a word (see DocFormat.runs). */
export const STYLE = { bold: 1, italic: 2, code: 4, strike: 8 } as const;

export type BlockKind = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'quote' | 'li' | 'code' | 'th' | 'tr';

/** How one paragraph is set: a heading, list item, code line and so on. */
export interface BlockStyle {
  kind: BlockKind;
  /** List nesting depth, 0 for top level. */
  depth?: number;
  /** Inside a block quote. */
  quote?: boolean;
  /** A list item's later lines: indented, no bullet. */
  cont?: boolean;
  /** Ordered list item: its number is part of the text, so no bullet is drawn. */
  ordered?: boolean;
}

/**
 * Formatting kept from Markdown or HTML, stored beside the plain text. It
 * never changes the words, only how the text views draw them. All ranges are
 * word indices [start, end) into segment(text); blocks are paragraph indices.
 */
export interface DocFormat {
  v: 1;
  /** [start, end, style bits] runs of styled words. */
  runs: [number, number, number][];
  /** [start, end, href] runs of linked words; http(s) and mailto only. */
  links: [number, number, string][];
  /** [paragraph index, style] for every paragraph that is not plain prose. */
  blocks: [number, BlockStyle][];
}
