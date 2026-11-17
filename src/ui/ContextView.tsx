import { memo, useEffect, useRef, type ReactNode } from 'react';
import { paragraphRange } from '../segment/nav';
import type { Word } from '../types';

/** Longest stretch of words rendered on either side of the current word. */
const WINDOW = 600;

interface Props {
  words: readonly Word[];
  index: number;
  onPick: (index: number) => void;
}

/**
 * The text around the current word, shown while paused so re-reading is one
 * glance away. Clicking any word jumps to it.
 */
export const ContextView = memo(function ContextView({ words, index, onPick }: Props) {
  const currentRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'center' });
  }, [index]);

  if (words.length === 0) return null;
  const [start, end] = paragraphRange(words, index);
  // One paragraph of context on each side, within a bounded window.
  const from = Math.max(start > 0 ? paragraphRange(words, start - 1)[0] : start, index - WINDOW);
  const to = Math.min(end < words.length ? paragraphRange(words, end)[1] : end, index + WINDOW);

  const paragraphs: ReactNode[] = [];
  let spans: ReactNode[] = [];
  for (let i = from; i < to; i++) {
    const w = words[i];
    if (spans.length && !w.glued) spans.push(' ');
    spans.push(
      <span
        key={i}
        ref={i === index ? currentRef : undefined}
        className={i === index ? 'ctx-word current' : 'ctx-word'}
        data-i={i}
      >
        {w.text}
      </span>,
    );
    if (w.paragraphEnd || i === to - 1) {
      const active = i >= start && i < end;
      paragraphs.push(
        <p key={w.paragraphIndex} className={active ? 'ctx-para active' : 'ctx-para'}>
          {spans}
        </p>,
      );
      spans = [];
    }
  }

  return (
    <div
      className="context"
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
