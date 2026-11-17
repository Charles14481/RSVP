import { useMemo, useState, type ReactNode } from 'react';
import type { ReaderSession } from '../player/session';
import { paragraphRange } from '../segment/nav';
import { baseInterval, pauseFactor, spilled, summarizePace, wordDuration, type Pacing } from '../timing/timing';
import { Panel } from './Panel';

/** Bits at which shading is darkest. */
const SHADE_MAX = 16;
/** At most this many words either side of the current one. */
const RADIUS = 700;

interface Props {
  session: ReaderSession;
  pacing: Pacing;
  index: number;
  onJump: (i: number) => void;
  onClose: () => void;
  modelLabel: string;
}

/**
 * The passage around the current word, each word shaded by surprisal with its
 * timing on hover. The tool for tuning settings and spotting alignment bugs:
 * a misaligned word shows up as an absurd value next to its neighbours.
 */
export function Inspector({ session, pacing, index, onJump, onClose, modelLabel }: Props) {
  const { words, surprisal } = session;
  const [hover, setHover] = useState<number | null>(null);
  const st = pacing.settings;
  const T = baseInterval(st);

  const [from, to] = useMemo(() => {
    if (!words.length) return [0, 0];
    let start = paragraphRange(words, index)[0];
    let end = paragraphRange(words, index)[1];
    // Two paragraphs either side, within the radius.
    for (let k = 0; k < 2 && start > 0; k++) start = paragraphRange(words, start - 1)[0];
    for (let k = 0; k < 2 && end < words.length; k++) end = paragraphRange(words, end)[1];
    return [Math.max(start, index - RADIUS), Math.min(end, index + RADIUS)];
  }, [words, index]);

  const passage = useMemo(() => {
    const paragraphs: ReactNode[] = [];
    let spans: ReactNode[] = [];
    for (let i = from; i < to; i++) {
      const w = words[i];
      const s = surprisal[i];
      if (spans.length && !w.glued) spans.push(' ');
      const style = Number.isNaN(s) ? undefined : { backgroundColor: `rgba(var(--heat), ${(Math.min(s, SHADE_MAX) / SHADE_MAX) * 0.85})` };
      const cls = `insp-word${Number.isNaN(s) ? ' unscored' : ''}${i === index ? ' current' : ''}${s > 12 ? ' hot' : ''}`;
      spans.push(
        <span key={i} data-i={i} className={cls} style={style}>
          {w.text}
        </span>,
      );
      if (w.paragraphEnd || i === to - 1) {
        paragraphs.push(<p key={i}>{spans}</p>);
        spans = [];
      }
    }
    return paragraphs;
    // session.version changes as scores arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words, surprisal, from, to, index, session.version]);

  const summary = useMemo(() => summarizePace(words, surprisal, pacing), [words, surprisal, pacing]);
  const scoredPct = words.length ? Math.floor((session.scoredCount / words.length) * 100) : 0;

  const detail = (i: number) => {
    const w = words[i];
    const s = surprisal[i];
    const d = wordDuration(words, surprisal, i, pacing);
    const pause = pauseFactor(w, st) * T;
    return (
      <>
        <strong>{w.text}</strong>
        <span>{Number.isNaN(s) ? 'not scored yet' : `${s.toFixed(2)} bits`}</span>
        {!Number.isNaN(s) && <span>after spillover {spilled(surprisal, i, st.spillover).toFixed(2)}</span>}
        <span>{Number.isNaN(d) ? '—' : `${Math.round(d)} ms${pause ? ` (incl. ${Math.round(pause)} ms pause)` : ''}`}</span>
      </>
    );
  };

  return (
    <Panel title="Inspector" onClose={onClose} wide>
      <div className="insp-stats">
        <span>{modelLabel}</span>
        <span>{scoredPct}% scored</span>
        <span>mean {session.mean.mean.toFixed(2)} bits/word</span>
        <span>{summary ? `${Math.round(summary.effectiveWpm)} wpm effective` : '—'}</span>
        <span className="insp-legend" aria-hidden="true">
          0 <i /> {SHADE_MAX}+ bits
        </span>
      </div>
      <div className="insp-readout" aria-live="polite">
        {hover != null ? detail(hover) : <span className="field-hint">Hover a word for its surprisal and duration. Click to jump there.</span>}
      </div>
      <div
        className="insp-passage"
        onMouseOver={(e) => {
          const i = (e.target as HTMLElement).dataset?.i;
          if (i !== undefined) setHover(Number(i));
        }}
        onClick={(e) => {
          const i = (e.target as HTMLElement).dataset?.i;
          if (i !== undefined) {
            onJump(Number(i));
            onClose();
          }
        }}
      >
        {from > 0 && <p className="ctx-more">…</p>}
        {passage}
        {to < words.length && <p className="ctx-more">…</p>}
      </div>
    </Panel>
  );
}
