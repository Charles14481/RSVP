import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ReaderSession } from '../player/session';
import { paraProps, wordClass } from '../segment/format';
import { paragraphRange } from '../segment/nav';
import type { Prediction } from '../surprisal/protocol';
import { baseInterval, pauseFactor, spilled, summarizePace, wordDuration, type Pacing } from '../timing/timing';
import { followLink, LINK_HINT } from './ContextView';
import { Panel } from './Panel';
import { useScrollWindow } from './useScrollWindow';

/** Bits at which shading is darkest. */
const SHADE_MAX = 16;
/** Without the whole text: at most this many words either side of the current one. */
const RADIUS = 700;

interface Props {
  session: ReaderSession;
  pacing: Pacing;
  index: number;
  /** Scroll through the whole text instead of a few paragraphs around the current word. */
  fullText: boolean;
  /** The model's top next tokens just before word i. */
  predict: (i: number) => Promise<Prediction>;
  onJump: (i: number) => void;
  onClose: () => void;
  modelLabel: string;
}

type PredictState =
  | { i: number; phase: 'loading' }
  | { i: number; phase: 'done'; result: Prediction }
  | { i: number; phase: 'error'; message: string };

function percent(p: number): string {
  if (p >= 0.1) return `${Math.round(p * 100)}%`;
  if (p >= 0.001) return `${(p * 100).toFixed(1)}%`;
  return '<0.1%';
}

/** A token as a reader would recognize it: no leading space, line breaks named. */
function tokenLabel(text: string): string {
  if (/^\s*\n/.test(text)) return '¶';
  const t = text.trim();
  return t || '␣';
}

/**
 * The passage around the current word, each word shaded by surprisal with its
 * timing on hover. The tool for tuning settings and spotting alignment bugs:
 * a misaligned word shows up as an absurd value next to its neighbours.
 * Clicking a word asks the model what it expected there instead.
 */
export function Inspector({ session, pacing, index, fullText, predict, onJump, onClose, modelLabel }: Props) {
  const { words, surprisal, styles } = session;
  const [hover, setHover] = useState<number | null>(null);
  const [pred, setPred] = useState<PredictState | null>(null);
  const passageRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef(0);
  const st = pacing.settings;
  const T = baseInterval(st);

  const scroll = useScrollWindow(words, index, () => passageRef.current?.closest<HTMLElement>('.panel-body') ?? null, fullText);
  const near = useMemo(() => {
    if (!words.length) return [0, 0] as const;
    let start = paragraphRange(words, index)[0];
    let end = paragraphRange(words, index)[1];
    // Two paragraphs either side, within the radius.
    for (let k = 0; k < 2 && start > 0; k++) start = paragraphRange(words, start - 1)[0];
    for (let k = 0; k < 2 && end < words.length; k++) end = paragraphRange(words, end)[1];
    return [Math.max(start, index - RADIUS), Math.min(end, index + RADIUS)] as const;
  }, [words, index]);
  const [from, to] = fullText ? [scroll.from, scroll.to] : near;

  useEffect(() => {
    passageRef.current?.querySelector('.insp-word.current')?.scrollIntoView({ block: 'center' });
  }, [fullText]);

  const picked = pred?.i ?? null;
  const passage = useMemo(() => {
    const paragraphs: ReactNode[] = [];
    let spans: ReactNode[] = [];
    for (let i = from; i < to; i++) {
      const w = words[i];
      const s = surprisal[i];
      if (spans.length && !w.glued) spans.push(' ');
      const style = Number.isNaN(s) ? undefined : { backgroundColor: `rgba(var(--heat), ${(Math.min(s, SHADE_MAX) / SHADE_MAX) * 0.85})` };
      const cls = `insp-word${Number.isNaN(s) ? ' unscored' : ''}${i === index ? ' current' : ''}${s > 12 ? ' hot' : ''}${i === picked ? ' picked' : ''}`;
      const href = styles?.href(i);
      spans.push(
        <span key={i} data-i={i} className={cls + wordClass(styles, i)} style={style} title={href ? `${href}\n${LINK_HINT}` : undefined}>
          {w.text}
        </span>,
      );
      if (w.paragraphEnd || i === to - 1) {
        const para = paraProps(styles, w.paragraphIndex);
        paragraphs.push(
          <p key={i} data-p="" className={para.className.trim() || undefined} style={para.style as CSSProperties | undefined}>
            {spans}
          </p>,
        );
        spans = [];
      }
    }
    return paragraphs;
    // session.version changes as scores arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words, surprisal, styles, from, to, index, picked, session.version]);

  const summary = useMemo(() => summarizePace(words, surprisal, pacing), [words, surprisal, pacing]);
  const scoredPct = words.length ? Math.floor((session.scoredCount / words.length) * 100) : 0;

  const ask = (i: number) => {
    const req = ++requestRef.current;
    setPred({ i, phase: 'loading' });
    predict(i).then(
      (result) => req === requestRef.current && setPred({ i, phase: 'done', result }),
      (e: unknown) => req === requestRef.current && setPred({ i, phase: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
  };

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

  const predictions = (p: PredictState) => {
    const word = words[p.i].text;
    let body: ReactNode;
    if (p.phase === 'loading') {
      body = (
        <p className="field-hint">
          <span className="spinner inline" aria-hidden="true" /> Asking {modelLabel}…
        </p>
      );
    } else if (p.phase === 'error') {
      body = <p className="field-hint">Could not get predictions: {p.message}</p>;
    } else {
      const { guesses, actual, context } = p.result;
      const top = guesses[0]?.p || 1;
      const hit = guesses.some((g) => g.id === actual.id);
      body = (
        <>
          <ol className="insp-guesses">
            {guesses.map((g) => (
              <li key={g.id} className={g.id === actual.id ? 'hit' : undefined} title={JSON.stringify(g.text)}>
                <span className="g-bar" style={{ width: `${(g.p / top) * 100}%` }} aria-hidden="true" />
                <span className="g-text">{tokenLabel(g.text)}</span>
                <span className="g-p">{percent(g.p)}</span>
              </li>
            ))}
          </ol>
          <p className="field-hint">
            {hit ? 'The text went with the highlighted guess' : `The text went with “${tokenLabel(actual.text)}”, guess #${actual.rank.toLocaleString()} at ${percent(actual.p)}`}
            {Number.isNaN(surprisal[p.i]) ? '.' : `; the whole word is ${surprisal[p.i].toFixed(1)} bits.`} Guesses are the model's next tokens
            given the {context.toLocaleString()} tokens before, so some are pieces of words or punctuation.
          </p>
        </>
      );
    }
    return (
      <div className="insp-predict" aria-live="polite">
        <div className="insp-predict-head">
          <span>
            Before <strong>{word}</strong>, the model expected
          </span>
          <span className="row tight">
            <button
              className="btn ghost small"
              onClick={() => {
                onJump(p.i);
                onClose();
              }}
            >
              Read from here
            </button>
            <button className="btn ghost square small" onClick={() => setPred(null)} aria-label="Close predictions">
              ×
            </button>
          </span>
        </div>
        {body}
      </div>
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
      <div className="insp-sticky">
        <div className="insp-readout" aria-live="polite">
          {hover != null ? (
            detail(hover)
          ) : (
            <span className="field-hint">Hover a word for its surprisal and duration. Click it to see what the model expected there.</span>
          )}
        </div>
        {pred && predictions(pred)}
      </div>
      <div
        className="insp-passage"
        ref={passageRef}
        onMouseOver={(e) => {
          const i = (e.target as HTMLElement).dataset?.i;
          if (i !== undefined) setHover(Number(i));
        }}
        onClick={(e) => {
          const i = (e.target as HTMLElement).dataset?.i;
          if (i !== undefined && !followLink(e, styles, Number(i))) ask(Number(i));
        }}
        onAuxClick={(e) => {
          const i = (e.target as HTMLElement).dataset?.i;
          if (i !== undefined && e.button === 1) followLink(e, styles, Number(i), true);
        }}
      >
        {from > 0 && <p className="ctx-more">…</p>}
        {passage}
        {to < words.length && <p className="ctx-more">…</p>}
      </div>
    </Panel>
  );
}
