/**
 * Sliding-window planning over a token sequence ids[0..N), where ids[0] is BOS.
 * "Target j" is the prediction of token j from the logits of token j - 1, for
 * 1 <= j < N. A window feeds input tokens [start, end) to the model and scores
 * targets [from, to], with to === end (the last row predicts token `end`).
 */
export interface Window {
  start: number;
  end: number;
  from: number;
  to: number;
}

/**
 * Choose the next window: the first unscored target at or after `cursor`
 * (wrapping to the beginning once the end is reached), scored together with
 * the following targets up to S in total. Every scored target then sees at
 * least W - S tokens of context, or the whole document prefix if shorter.
 * When a window would start at the BOS anyway it is extended to the full W,
 * which is what the plan's "first window" is.
 */
export function planWindow(scored: Uint8Array, W: number, S: number, cursor = 1, hint?: { pos: number }): Window | null {
  const N = scored.length;
  if (N < 2) return null;
  if (!(W >= 2) || !(S >= 1) || S > W) throw new Error(`Invalid window ${W} / stride ${S}`);
  const j = firstUnscored(scored, Math.max(1, cursor), hint) ?? firstUnscored(scored, 1);
  if (j == null) return null;
  let to = j - 1 + S;
  if (to <= W) to = W;
  to = Math.min(to, N - 1);
  const start = Math.max(0, to - W);
  return { start, end: to, from: j, to };
}

function firstUnscored(scored: Uint8Array, from: number, hint?: { pos: number }): number | null {
  // The hint remembers how far a previous scan from the same cursor got, so
  // repeated planning from one cursor stays linear over the whole document.
  let i = hint && hint.pos > from ? hint.pos : from;
  while (i < scored.length && scored[i]) i++;
  if (hint) hint.pos = i;
  return i < scored.length ? i : null;
}
