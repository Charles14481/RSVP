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
