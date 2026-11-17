import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { WordDisplay } from '../player/display';
import { Scheduler, type PlayState } from '../player/scheduler';
import type { ReaderSession } from '../player/session';
import { nextSentenceStart, paragraphStart, previousSentenceStart, sentenceStart } from '../segment/nav';
import type { Settings } from '../settings';
import { summarizePace, wordDuration, WPM_MAX, WPM_MIN, WPM_STEP, type Pacing } from '../timing/timing';
import { ContextView } from './ContextView';
import { formatDuration } from './format';

export interface ReaderProps {
  title: string;
  session: ReaderSession;
  settings: Settings;
  onSettings: (update: (s: Settings) => Settings) => void;
  initialIndex?: number;
  onPosition?: (index: number) => void;
  /** The reader needs word i timed soon: called on seeks and when playback starts buffering. */
  onNeedWord?: (index: number) => void;
  onExit: () => void;
  /** Shown instead of the word while buffering (model status, scoring progress). */
  bufferingMessage?: ReactNode;
  /** A blocking problem (model failed to load, alignment error) with its remedies. */
  problem?: ReactNode;
  /** Extra top-bar controls. */
  actions?: ReactNode;
  /** A panel rendered over the reader. While one is open, playback pauses and shortcuts are off. */
  overlay?: ((ctx: { index: number; jump: (i: number) => void }) => ReactNode) | null;
  onCloseOverlay?: () => void;
  /** Extra single-key shortcuts (lowercased key); return true if handled. */
  onKey?: (key: string) => boolean;
}

const TEXT_ENTRY = /^(INPUT|TEXTAREA|SELECT)$/;

export function Reader(props: ReaderProps) {
  const { title, session, settings, onSettings, onExit, onPosition } = props;
  const words = session.words;

  const stageRef = useRef<HTMLDivElement | null>(null);
  const wordRef = useRef<HTMLDivElement | null>(null);
  const leftRef = useRef<HTMLSpanElement | null>(null);
  const pivotRef = useRef<HTMLSpanElement | null>(null);
  const rightRef = useRef<HTMLSpanElement | null>(null);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const schedulerRef = useRef<Scheduler | null>(null);
  const displayRef = useRef<WordDisplay | null>(null);
  const lastLabelAt = useRef(0);
  /** True after an explicit jump while paused: resume exactly there, not at the sentence start. */
  const exactResume = useRef(false);

  const [playState, setPlayState] = useState<PlayState>('paused');
  const [index, setIndex] = useState(() => clampIndex(props.initialIndex ?? 0, words.length));

  const version = useSyncExternalStore(session.subscribe, () => session.version);
  const pacing: Pacing = useMemo(
    () => ({ settings: settings.timing, meanS: session.mean.mean, fixed: settings.pacing === 'fixed' }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.timing, settings.pacing, session, version],
  );
  const summary = useMemo(() => summarizePace(words, session.surprisal, pacing), [words, session, pacing]);

  // The scheduler reads these through refs so settings apply to the very next word.
  const pacingRef = useRef(pacing);
  pacingRef.current = pacing;
  const meanMsRef = useRef<number | null>(null);
  meanMsRef.current = summary?.meanMs ?? null;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;
  const onNeedWordRef = useRef(props.onNeedWord);
  onNeedWordRef.current = props.onNeedWord;
  const onKeyRef = useRef(props.onKey);
  onKeyRef.current = props.onKey;
  const overlayOpen = Boolean(props.overlay);
  const overlayOpenRef = useRef(overlayOpen);
  overlayOpenRef.current = overlayOpen;

  const writeProgress = useCallback(
    (i: number, force: boolean) => {
      const n = words.length;
      if (fillRef.current) fillRef.current.style.transform = `scaleX(${n > 1 ? i / (n - 1) : 1})`;
      const now = performance.now();
      if (!force && now - lastLabelAt.current < 400) return;
      lastLabelAt.current = now;
      if (labelRef.current) {
        const pct = n > 1 ? Math.round((i / (n - 1)) * 100) : 100;
        const meanMs = meanMsRef.current;
        const left = meanMs == null ? '' : ` · ${formatDuration((n - 1 - i) * meanMs)} left`;
        labelRef.current.textContent = `${pct}%${left}`;
      }
    },
    [words],
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !wordRef.current || !leftRef.current || !pivotRef.current || !rightRef.current) return;
    const display = new WordDisplay(stage, wordRef.current, leftRef.current, pivotRef.current, rightRef.current);
    const scheduler = new Scheduler({
      now: () => performance.now(),
      requestFrame: (cb) => requestAnimationFrame(cb),
      cancelFrame: (h) => cancelAnimationFrame(h),
      wordCount: () => words.length,
      duration: (i) => {
        const d = wordDuration(words, session.surprisal, i, pacingRef.current);
        return Number.isNaN(d) ? null : d;
      },
      show: (i) => {
        display.show(words[i].text);
        writeProgress(i, false);
      },
      onState: (s) => {
        setPlayState(s);
        if (s === 'buffering') onNeedWordRef.current?.(scheduler.index);
        if (s === 'paused' || s === 'ended') {
          setIndex(scheduler.index);
          writeProgress(scheduler.index, true);
          onPositionRef.current?.(scheduler.index);
        }
      },
    });
    displayRef.current = display;
    schedulerRef.current = scheduler;
    scheduler.seek(clampIndex(props.initialIndex ?? 0, words.length));
    writeProgress(scheduler.index, true);

    const resize = new ResizeObserver(() => display.measure());
    resize.observe(stage);
    const saver = setInterval(() => {
      if (scheduler.running) onPositionRef.current?.(scheduler.index);
    }, 5000);
    // Exposed for the timing check in the README: actual minus scheduled onsets.
    (window as unknown as { __rsvpOnsets?: unknown }).__rsvpOnsets = scheduler.stats;

    return () => {
      clearInterval(saver);
      resize.disconnect();
      onPositionRef.current?.(scheduler.index);
      scheduler.dispose();
      schedulerRef.current = null;
      displayRef.current = null;
    };
    // initialIndex is read once per session on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, words, writeProgress]);

  // Font size changes the metrics the display caches.
  useEffect(() => {
    displayRef.current?.measure();
  }, [settings.fontSize]);

  // Keep the time-left label honest when the pace changes while paused.
  useEffect(() => {
    const s = schedulerRef.current;
    if (s) writeProgress(s.index, true);
  }, [summary, writeProgress]);

  const play = useCallback(() => {
    const s = schedulerRef.current;
    if (!s || s.running) return;
    if (s.state === 'paused' && settingsRef.current.resumeAtSentenceStart && !exactResume.current) {
      s.seek(sentenceStart(words, s.index));
    }
    onNeedWordRef.current?.(s.index);
    exactResume.current = false;
    s.play();
  }, [words]);

  const pause = useCallback(() => schedulerRef.current?.pause(), []);

  const toggle = useCallback(() => {
    if (schedulerRef.current?.running) pause();
    else play();
  }, [play, pause]);

  const jump = useCallback(
    (i: number) => {
      const s = schedulerRef.current;
      if (!s) return;
      s.seek(i);
      onNeedWordRef.current?.(s.index);
      if (!s.running) {
        exactResume.current = true;
        setIndex(s.index);
        writeProgress(s.index, true);
        onPositionRef.current?.(s.index);
      }
    },
    [writeProgress],
  );

  const changeWpm = useCallback(
    (delta: number) => {
      onSettings((s) => ({
        ...s,
        timing: { ...s.timing, targetWpm: Math.max(WPM_MIN, Math.min(WPM_MAX, s.timing.targetWpm + delta)) },
      }));
    },
    [onSettings],
  );

  const { onCloseOverlay } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (overlayOpenRef.current) {
        if (e.key === 'Escape') onCloseOverlay?.();
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || TEXT_ENTRY.test(target.tagName))) return;
      const s = schedulerRef.current;
      if (!s) return;
      switch (e.key) {
        case ' ':
          // Space on a focused button would also click it; take the focus away first.
          if (target?.tagName === 'BUTTON') target.blur();
          toggle();
          break;
        case 'ArrowLeft':
          // While playing, the first couple of words still count as "at the start".
          jump(previousSentenceStart(words, s.index, s.running ? 2 : 0));
          break;
        case 'ArrowRight':
          jump(nextSentenceStart(words, s.index));
          break;
        case 'ArrowUp':
          changeWpm(WPM_STEP);
          break;
        case 'ArrowDown':
          changeWpm(-WPM_STEP);
          break;
        case 'r':
        case 'R':
          jump(paragraphStart(words, s.index));
          break;
        case 'Escape':
          onExit();
          break;
        default:
          if (!onKeyRef.current?.(e.key.toLowerCase())) return;
      }
      e.preventDefault();
    };
    const onVisibility = () => {
      if (document.hidden) schedulerRef.current?.pause();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [words, toggle, jump, changeWpm, onExit, onCloseOverlay]);

  // Opening a panel pauses playback.
  useEffect(() => {
    if (overlayOpen) schedulerRef.current?.pause();
  }, [overlayOpen]);

  const seekFromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    jump(Math.round(frac * (words.length - 1)));
  };

  const running = playState === 'playing' || playState === 'buffering';
  const touch = useMemo(() => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches, []);
  const showContext = !running && !props.problem;
  const wpm = settings.timing.targetWpm;

  return (
    <div className="reader" data-state={playState}>
      <header className="reader-bar">
        <button className="btn ghost back" onClick={onExit} title="Back to library (Esc)" aria-label="Back to library">
          <span aria-hidden="true">←</span>
          <span className="wide-only"> Library</span>
        </button>
        <div className="reader-title" title={title}>
          {title}
        </div>
        <div className="rate" title="Target rate before pauses (Up / Down)">
          <button className="btn ghost square" onClick={() => changeWpm(-WPM_STEP)} aria-label="Slower">
            −
          </button>
          <span className="rate-value">
            <strong>{wpm}</strong> wpm
          </span>
          <button className="btn ghost square" onClick={() => changeWpm(WPM_STEP)} aria-label="Faster">
            +
          </button>
          <span className="rate-effective" title="Effective rate including pauses and clamps">
            {summary ? `${Math.round(summary.effectiveWpm)} effective` : '— effective'}
          </span>
        </div>
        {props.actions}
      </header>

      <main className="reader-main" onClick={toggle}>
        <div className="stage" ref={stageRef} style={{ fontSize: `min(${settings.fontSize}px, 12vw)` }}>
          <div className="stage-guide" aria-hidden="true" />
          <div className="rsvp-word" ref={wordRef} aria-live="off">
            <span ref={leftRef} />
            <span ref={pivotRef} className="pivot" />
            <span ref={rightRef} />
          </div>
          {playState === 'buffering' && (
            <div className="buffering" role="status">
              <span className="spinner" aria-hidden="true" />
              {props.bufferingMessage ?? 'Scoring ahead…'}
            </div>
          )}
        </div>

        {props.problem && (
          <div className="problem" role="alert" onClick={(e) => e.stopPropagation()}>
            {props.problem}
          </div>
        )}

        {showContext && (
          <>
            <div className="hint">
              {playState === 'ended'
                ? touch
                  ? 'Finished. Tap to read again.'
                  : 'Finished. Space to read again.'
                : touch
                  ? 'Tap the word to read · tap the text to jump'
                  : 'Space to read · click any word to jump · ? for shortcuts'}
            </div>
            <ContextView words={words} index={index} onPick={jump} />
          </>
        )}
      </main>

      <footer className="reader-foot">
        <button
          className="btn ghost square"
          onClick={() => {
            const s = schedulerRef.current;
            if (s) jump(previousSentenceStart(words, s.index, s.running ? 2 : 0));
          }}
          aria-label="Previous sentence"
          title="Previous sentence (Left)"
        >
          ‹
        </button>
        <button className="btn primary play" onClick={toggle} aria-label={running ? 'Pause' : 'Play'}>
          {running ? 'Pause' : 'Play'}
        </button>
        <button
          className="btn ghost square"
          onClick={() => {
            const s = schedulerRef.current;
            if (s) jump(nextSentenceStart(words, s.index));
          }}
          aria-label="Next sentence"
          title="Next sentence (Right)"
        >
          ›
        </button>
        <div
          className="progress"
          role="slider"
          aria-label="Position"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, words.length - 1)}
          aria-valuenow={index}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            seekFromPointer(e);
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) seekFromPointer(e);
          }}
        >
          <div className="progress-fill" ref={fillRef} />
        </div>
        <span className="progress-label" ref={labelRef} />
      </footer>

      {props.overlay?.({ index, jump })}
    </div>
  );
}

function clampIndex(i: number, n: number): number {
  return Math.max(0, Math.min(Math.max(0, n - 1), Math.floor(i)));
}
