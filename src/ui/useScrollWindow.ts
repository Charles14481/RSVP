import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { paragraphRange, paragraphStart } from '../segment/nav';
import type { Word } from '../types';

/** Words rendered on each side of the current word when the view is (re)centred. */
const INITIAL = 2000;
/** Words added when scrolling comes near either edge of what is rendered. */
const CHUNK = 1500;
/**
 * Most words rendered at once. A whole book is too many spans to build on every
 * pause, so past this the side away from the scroll direction is trimmed.
 */
const MAX = 12000;
/** Distance from an edge, in pixels, at which more text is loaded. */
const EDGE_PX = 800;

type Range = readonly [number, number];

/** A start at or before x, on a paragraph boundary unless that is more than CHUNK words back. */
function snapStart(words: readonly Word[], x: number): number {
  if (x <= 0) return 0;
  return Math.max(paragraphStart(words, x), x - CHUNK);
}

/** An end at or after x, on a paragraph boundary unless that is more than CHUNK words on. */
function snapEnd(words: readonly Word[], x: number): number {
  if (x >= words.length) return words.length;
  return Math.min(paragraphRange(words, x)[1], x + CHUNK);
}

function around(words: readonly Word[], i: number): Range {
  return [snapStart(words, i - INITIAL), snapEnd(words, i + INITIAL)];
}

interface Anchor {
  i: number;
  offset: number;
}

/**
 * The first word of the topmost visible paragraph (an element with `data-p`)
 * and where it sits relative to the scroll container.
 */
function captureAnchor(el: HTMLElement): Anchor | null {
  const top = el.getBoundingClientRect().top;
  const paras = el.querySelectorAll<HTMLElement>('[data-p]');
  let lo = 0;
  let hi = paras.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (paras[mid].getBoundingClientRect().bottom > top) {
      found = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  const w = found >= 0 ? paras[found].querySelector<HTMLElement>('[data-i]') : null;
  return w ? { i: Number(w.dataset.i), offset: w.getBoundingClientRect().top - top } : null;
}

export interface ScrollWindow {
  /** Half-open range of words to render. */
  from: number;
  to: number;
  /** Make sure word i is rendered, recentring on it if not. Returns true if it recentred. */
  ensure: (i: number) => boolean;
}

/**
 * Which stretch of a long text to render in a scrolling view: a window around
 * `index` that grows as the scroll container nears either end. Words must be
 * spans with `data-i`, grouped in paragraph elements with `data-p`. A new index
 * keeps the loaded range when it is already inside it.
 */
export function useScrollWindow(
  words: readonly Word[],
  index: number,
  getScrollEl: () => HTMLElement | null,
  enabled = true,
): ScrollWindow {
  const [view, setView] = useState(() => ({ words, index, range: around(words, index) }));
  let range = view.range;
  if (view.words !== words || view.index !== index) {
    const keep = view.words === words && index >= range[0] && index < range[1];
    if (!keep) range = around(words, index);
    setView({ words, index, range });
  }
  const [from, to] = range;

  const rangeRef = useRef(range);
  rangeRef.current = range;
  const wordsRef = useRef(words);
  wordsRef.current = words;
  const getRef = useRef(getScrollEl);
  getRef.current = getScrollEl;
  const anchorRef = useRef<Anchor | null>(null);

  // Keep the visible text still when text is added or removed above it.
  useLayoutEffect(() => {
    const a = anchorRef.current;
    const el = getRef.current();
    anchorRef.current = null;
    if (!a || !el) return;
    const w = el.querySelector<HTMLElement>(`[data-i="${a.i}"]`);
    if (w) el.scrollTop += w.getBoundingClientRect().top - el.getBoundingClientRect().top - a.offset;
  }, [from, to]);

  useEffect(() => {
    const el = getRef.current();
    if (!enabled || !el) return;
    const onScroll = () => {
      if (anchorRef.current) return;
      const n = words.length;
      let [f, t] = rangeRef.current;
      if (el.scrollTop < EDGE_PX && f > 0) {
        f = snapStart(words, f - CHUNK);
        if (t - f > MAX) t = Math.min(t, snapEnd(words, f + MAX));
      } else if (el.scrollHeight - el.scrollTop - el.clientHeight < EDGE_PX && t < n) {
        t = snapEnd(words, t + CHUNK);
        if (t - f > MAX) f = Math.max(f, snapStart(words, t - MAX));
      } else return;
      anchorRef.current = captureAnchor(el);
      rangeRef.current = [f, t];
      setView((v) => ({ ...v, range: [f, t] }));
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [enabled, words]);

  const ensure = useCallback((i: number) => {
    const [f, t] = rangeRef.current;
    if (i >= f && i < t) return false;
    const r = around(wordsRef.current, i);
    rangeRef.current = r;
    anchorRef.current = null;
    setView((v) => ({ ...v, range: r }));
    return true;
  }, []);

  return { from, to, ensure };
}
