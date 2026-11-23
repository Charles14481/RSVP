import { WordDisplay } from '../player/display';
import { groupEnd, groupText } from '../player/groups';
import { Scheduler, type PlayState } from '../player/scheduler';
import type { ReaderSession } from '../player/session';
import { groupBits } from '../segment/format';
import { nextSentenceStart, paragraphStart, previousSentenceStart, sentenceStart } from '../segment/nav';
import type { Settings } from '../settings';
import { summarizePace, wordDuration, WPM_MAX, WPM_MIN, WPM_STEP, type Pacing } from '../timing/timing';
import { formatDuration } from '../ui/format';
import type { PageHighlighter } from './highlight';
import type { Overlay } from './overlay';
import type { AllSettings } from './settings';

export interface PlayerHooks {
  /** Word i needs to be scored soon (a seek, or playback started buffering). */
  onNeedWord(i: number): void;
  /** A position worth saving (paused, ended, or every few seconds while playing). */
  onPosition(i: number): void;
  onState(s: PlayState): void;
  /** Change the stored settings. */
  onSettings(update: (s: Settings) => Settings): void;
  onClose(): void;
}

const TEXT_ENTRY = /^(INPUT|TEXTAREA|SELECT)$/;

/**
 * Plays a page: the app's Reader logic without React. The scheduler puts each
 * word (or group) in the overlay's box and, in the same call, highlights it in
 * the page and keeps it in view.
 */
export class PagePlayer {
  readonly scheduler: Scheduler;
  private readonly display: WordDisplay;
  private readonly words;
  /** After an explicit jump while paused, resume exactly there rather than at the sentence start. */
  private exactResume = false;
  private meanMs: number | null = null;
  private effectiveWpm: number | null = null;
  private lastLabelAt = 0;
  private summaryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly saver: ReturnType<typeof setInterval>;
  private readonly resize: ResizeObserver;

  constructor(
    private readonly session: ReaderSession,
    private readonly overlay: Overlay,
    private readonly highlighter: PageHighlighter,
    private readonly getSettings: () => AllSettings,
    private readonly hooks: PlayerHooks,
    initialIndex: number,
  ) {
    this.words = session.words;
    const words = this.words;
    this.display = new WordDisplay(overlay.stage, overlay.word, overlay.left, overlay.pivot, overlay.right);
    overlay.setLength(words.length);
    const end = (i: number) => groupEnd(words, i, this.getSettings().settings.wordsPerFlash);
    this.scheduler = new Scheduler({
      now: () => performance.now(),
      requestFrame: (cb) => requestAnimationFrame(cb),
      cancelFrame: (h) => cancelAnimationFrame(h),
      wordCount: () => words.length,
      // A group stays up for the sum of its words' durations, so the pace is the same at any size.
      duration: (i) => {
        const pacing = this.pacing();
        let total = 0;
        for (let k = i, e = end(i); k < e; k++) {
          const d = wordDuration(words, session.surprisal, k, pacing);
          if (Number.isNaN(d)) return null;
          total += d;
        }
        return total;
      },
      next: end,
      show: (i) => {
        const e = end(i);
        const { ext } = this.getSettings();
        if (ext.display === 'box') this.display.show(groupText(words, i, e), groupBits(session.styles, words, i, e));
        this.highlighter.show(i, e, { mode: ext.highlight, follow: ext.follow });
        this.writeProgress(i, false);
      },
      onState: (s) => {
        overlay.setState(s);
        hooks.onState(s);
        if (s === 'buffering') hooks.onNeedWord(this.scheduler.index);
        if (s === 'paused' || s === 'ended') {
          this.writeProgress(this.scheduler.index, true);
          hooks.onPosition(this.scheduler.index);
        }
      },
    });

    this.resize = new ResizeObserver(() => this.display.measure());
    this.resize.observe(overlay.stage);
    this.saver = setInterval(() => {
      if (this.scheduler.running) hooks.onPosition(this.scheduler.index);
    }, 5000);
    this.refreshSummary();
    this.scheduler.seek(clamp(initialIndex, words.length));
    this.highlighter.reveal(this.scheduler.index, end(this.scheduler.index));
  }

  get index(): number {
    return this.scheduler.index;
  }

  get running(): boolean {
    return this.scheduler.running;
  }

  play(): void {
    const s = this.scheduler;
    if (s.running) return;
    if (s.state === 'paused' && this.getSettings().settings.resumeAtSentenceStart && !this.exactResume) {
      s.seek(sentenceStart(this.words, s.index));
    }
    this.hooks.onNeedWord(s.index);
    this.exactResume = false;
    s.play();
  }

  pause(): void {
    this.scheduler.pause();
  }

  toggle(): void {
    if (this.scheduler.running) this.pause();
    else this.play();
  }

  /** Jump to word i; keeps playing if playing. */
  jump(i: number, reveal = false): void {
    const s = this.scheduler;
    s.seek(i);
    this.hooks.onNeedWord(s.index);
    if (!s.running) {
      this.exactResume = true;
      this.writeProgress(s.index, true);
      this.hooks.onPosition(s.index);
    }
    if (reveal) this.highlighter.reveal(s.index, s.index + 1);
  }

  previousSentence(): void {
    const s = this.scheduler;
    // While playing, the first couple of words still count as "at the start".
    this.jump(previousSentenceStart(this.words, s.index, s.running ? 2 : 0), true);
  }

  nextSentence(): void {
    this.jump(nextSentenceStart(this.words, this.scheduler.index), true);
  }

  restartParagraph(): void {
    this.jump(paragraphStart(this.words, this.scheduler.index), true);
  }

  seekFraction(f: number): void {
    this.jump(Math.round(f * (this.words.length - 1)), true);
  }

  changeWpm(delta: number): void {
    this.hooks.onSettings((s) => ({
      ...s,
      timing: { ...s.timing, targetWpm: Math.max(WPM_MIN, Math.min(WPM_MAX, s.timing.targetWpm + delta)) },
    }));
  }

  /** Settings changed: re-measure the box, re-show the current group when paused, update the pace. */
  settingsChanged(): void {
    this.display.measure();
    const s = this.scheduler;
    if (!s.running) s.seek(s.index);
    this.refreshSummary();
  }

  /** New scores arrived: the effective rate and time left change (at most once a second). */
  scoresChanged(): void {
    this.summaryTimer ??= setTimeout(() => {
      this.summaryTimer = undefined;
      this.refreshSummary();
    }, 1000);
  }

  /** Reader keys while the overlay is open. Returns true if the key was handled. */
  handleKey(e: KeyboardEvent, overlayHost: Element): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const target = e.target as HTMLElement | null;
    if (target && target !== overlayHost && (target.isContentEditable || TEXT_ENTRY.test(target.tagName))) return false;
    switch (e.key) {
      case ' ':
        // Space on a focused overlay button would also click it.
        if (target === overlayHost) (document.activeElement as HTMLElement | null)?.blur();
        this.toggle();
        return true;
      case 'ArrowLeft':
        this.previousSentence();
        return true;
      case 'ArrowRight':
        this.nextSentence();
        return true;
      case 'ArrowUp':
        this.changeWpm(WPM_STEP);
        return true;
      case 'ArrowDown':
        this.changeWpm(-WPM_STEP);
        return true;
      case 'r':
      case 'R':
        this.restartParagraph();
        return true;
      case '1':
      case '2':
      case '3': {
        const n = Number(e.key);
        this.hooks.onSettings((st) => ({ ...st, wordsPerFlash: n }));
        return true;
      }
      case 'Escape':
        this.hooks.onClose();
        return true;
    }
    return false;
  }

  dispose(): void {
    this.hooks.onPosition(this.scheduler.index);
    clearInterval(this.saver);
    clearTimeout(this.summaryTimer);
    this.resize.disconnect();
    this.scheduler.dispose();
  }

  private pacing(): Pacing {
    const { settings } = this.getSettings();
    return { settings: settings.timing, meanS: this.session.mean.mean, fixed: settings.pacing === 'fixed' };
  }

  private refreshSummary(): void {
    const summary = summarizePace(this.words, this.session.surprisal, this.pacing());
    this.meanMs = summary?.meanMs ?? null;
    this.effectiveWpm = summary?.effectiveWpm ?? null;
    this.overlay.setRate(this.getSettings().settings.timing.targetWpm, this.effectiveWpm);
    this.writeProgress(this.scheduler?.index ?? 0, true);
  }

  private writeProgress(i: number, force: boolean): void {
    const now = performance.now();
    if (!force && now - this.lastLabelAt < 400) {
      this.overlay.setProgress(i, null);
      return;
    }
    this.lastLabelAt = now;
    const n = this.words.length;
    const pct = n > 1 ? Math.round((i / (n - 1)) * 100) : 100;
    const left = this.meanMs == null ? '' : ` · ${formatDuration((n - 1 - i) * this.meanMs)} left`;
    this.overlay.setProgress(i, `${pct}%${left}`);
  }
}

function clamp(i: number, n: number): number {
  return Math.max(0, Math.min(Math.max(0, n - 1), Math.floor(i)));
}
