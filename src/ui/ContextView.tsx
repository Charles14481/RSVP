import { memo, useCallback, useEffect, useLayoutEffect, useRef, type MutableRefObject, type ReactNode } from 'react';
import { paragraphRange } from '../segment/nav';
import type { Word } from '../types';
import { useScrollWindow } from './useScrollWindow';

/** After the reader scrolls the text by hand, following playback waits this long. */
const HOLD_MS = 3000;

interface Props {
  words: readonly Word[];
  index: number;
  onPick: (index: number) => void;
  /** Playback is running: dim the text and follow the word being shown. */
  live?: boolean;
  /** Set to the follow function while live; the reader calls it with the words [i, end) on screen. */
  followRef?: MutableRefObject<((i: number, end: number) => void) | null>;
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Whether el lies entirely within the visible part of the scroll container. */
function inView(container: HTMLElement, el: HTMLElement): boolean {
  const box = container.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return r.top >= box.top && r.bottom <= box.bottom;
}

/**
 * The text around the current word. It scrolls, loading more near either edge,
 * and clicking any word jumps to it. Shown while paused so re-reading is one
 * glance away, and optionally while playing, dimmed, following along.
 */
export const ContextView = memo(function ContextView({ words, index, onPick, live = false, followRef }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const currentRef = useRef<HTMLSpanElement | null>(null);
  const { from, to, ensure } = useScrollWindow(words, index, () => scrollRef.current);

  // Paused: bring the current word into view unless it already is.
  useEffect(() => {
    const el = scrollRef.current;
    const cur = currentRef.current;
    if (live || !el || !cur) return;
    el.querySelector('.ctx-word.live')?.classList.remove('live');
    if (!inView(el, cur)) cur.scrollIntoView({ block: 'center' });
  }, [index, live]);

  // Live: the words being shown are marked outside React, once per flash.
  const liveRange = useRef<[number, number]>([-1, -1]);
  const liveEls = useRef<HTMLElement[]>([]);
  const holdUntil = useRef(0);

  const unmark = useCallback(() => {
    for (const w of liveEls.current) w.classList.remove('live');
    liveEls.current = [];
  }, []);

  const mark = useCallback((i: number, end: number, instant: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    // Usually the next word is the next span, or the first span of the next paragraph.
    const after = (s: HTMLElement) => (s.nextElementSibling ?? s.parentElement?.nextElementSibling?.firstElementChild) as HTMLElement | null;
    const last = liveEls.current[liveEls.current.length - 1];
    let w: HTMLElement | null = null;
    if (last?.isConnected) {
      const next = after(last);
      if (next?.dataset.i === String(i)) w = next;
    }
    w ??= el.querySelector<HTMLElement>(`[data-i="${i}"]`);
    unmark();
    if (!w) return;
    const first = w;
    for (let k = i; w && k < end; k++) {
      if (w.dataset.i !== String(k)) break;
      w.classList.add('live');
      liveEls.current.push(w);
      w = after(w);
    }
    if (performance.now() < holdUntil.current) return;
    const box = el.getBoundingClientRect();
    const y = first.getBoundingClientRect().top - box.top;
    if (y < box.height * 0.15 || y > box.height * 0.6) {
      el.scrollTo({ top: el.scrollTop + y - box.height * 0.3, behavior: instant || reducedMotion() ? 'auto' : 'smooth' });
    }
  }, [unmark]);

  const follow = useCallback(
    (i: number, end: number) => {
      liveRange.current = [i, end];
      if (!ensure(i) && !ensure(end - 1)) mark(i, end, false);
    },
    [ensure, mark],
  );

  // After a recentre the old spans are gone; mark the live words in the new ones.
  useLayoutEffect(() => {
    const [i, end] = liveRange.current;
    if (live && i >= 0) mark(i, end, true);
  }, [from, to, live, mark]);

  useEffect(() => {
    if (!followRef) return;
    followRef.current = live ? follow : null;
    if (!live) {
      unmark();
      liveRange.current = [-1, -1];
    }
    return () => {
      followRef.current = null;
    };
  }, [live, follow, followRef, unmark]);

  if (words.length === 0) return null;
  const [start, end] = paragraphRange(words, index);

  const paragraphs: ReactNode[] = [];
  let spans: ReactNode[] = [];
  for (let i = from; i < to; i++) {
    const w = words[i];
    if (spans.length && !w.glued) spans.push(' ');
    const current = i === index && !live;
    spans.push(
      <span key={i} ref={current ? currentRef : undefined} className={current ? 'ctx-word current' : 'ctx-word'} data-i={i}>
        {w.text}
      </span>,
    );
    if (w.paragraphEnd || i === to - 1) {
      const active = !live && i >= start && i < end;
      paragraphs.push(
        <p key={w.paragraphIndex} className={active ? 'ctx-para active' : 'ctx-para'} data-p="">
          {spans}
        </p>,
      );
      spans = [];
    }
  }

  const hold = () => {
    holdUntil.current = performance.now() + HOLD_MS;
  };

  return (
    <div
      className={live ? 'context live' : 'context'}
      ref={scrollRef}
      onWheel={hold}
      onTouchMove={hold}
      onClick={(e) => {
        e.stopPropagation();
        const i = (e.target as HTMLElement).dataset?.i;
        if (i !== undefined) onPick(Number(i));
      }}
    >
      {from > 0 && <div className="ctx-more">…</div>}
      {paragraphs}
      {to < words.length && <div className="ctx-more">…</div>}
    </div>
  );
});
