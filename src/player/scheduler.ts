export type PlayState = 'paused' | 'playing' | 'buffering' | 'ended';

export interface SchedulerHost {
  /** Monotonic clock in ms (performance.now in the browser). */
  now(): number;
  requestFrame(cb: () => void): number;
  cancelFrame(handle: number): void;
  wordCount(): number;
  /** Display duration of word i in ms, or null if it cannot be timed yet. */
  duration(i: number): number | null;
  /** Put word i on screen (with the words after it, when several are shown at once). Called outside React render. */
  show(i: number): void;
  /** Index shown after the unit starting at i; i + 1 when one word is shown at a time. */
  next?(i: number): number;
  onState?(state: PlayState): void;
}

/** If a word goes up this late (a stalled tab, a long GC), restart the clock instead of rushing. */
const RESYNC_MS = 250;

/** Actual minus scheduled word onsets, for verifying the scheduler. */
export class OnsetStats {
  count = 0;
  private sumAbs = 0;
  maxAbs = 0;

  record(errorMs: number): void {
    const abs = Math.abs(errorMs);
    this.count++;
    this.sumAbs += abs;
    if (abs > this.maxAbs) this.maxAbs = abs;
  }

  get meanAbs(): number {
    return this.count ? this.sumAbs / this.count : 0;
  }

  reset(): void {
    this.count = 0;
    this.sumAbs = 0;
    this.maxAbs = 0;
  }
}

/**
 * Frame-driven word scheduler. Each word's deadline is the previous deadline
 * plus its duration, so rounding to frames never accumulates; a word goes up
 * on the frame nearest its deadline.
 */
export class Scheduler {
  private idx = 0;
  private st: PlayState = 'paused';
  private deadline = 0;
  private handle = 0;
  private lastTick = NaN;
  private frameMs = 1000 / 60;
  readonly stats = new OnsetStats();

  constructor(private readonly host: SchedulerHost) {}

  get index(): number {
    return this.idx;
  }

  get state(): PlayState {
    return this.st;
  }

  get running(): boolean {
    return this.st === 'playing' || this.st === 'buffering';
  }

  play(): void {
    if (this.running || this.host.wordCount() === 0) return;
    if (this.st === 'ended') this.idx = 0;
    this.begin();
  }

  pause(): void {
    if (!this.running) return;
    this.stopLoop();
    this.setState('paused');
  }

  toggle(): void {
    if (this.running) this.pause();
    else this.play();
  }

  /** Jump to word i. Keeps playing if playing. */
  seek(i: number): void {
    const n = this.host.wordCount();
    if (n === 0) return;
    this.idx = Math.max(0, Math.min(n - 1, Math.floor(i)));
    if (this.running) {
      this.begin();
    } else {
      this.host.show(this.idx);
      if (this.st === 'ended') this.setState('paused');
    }
  }

  dispose(): void {
    this.stopLoop();
  }

  /** Show the current word and start its clock, or wait for it to be timed. */
  private begin(): void {
    const d = this.host.duration(this.idx);
    if (d == null) {
      this.setState('buffering');
    } else {
      this.host.show(this.idx);
      this.deadline = this.host.now() + d;
      this.setState('playing');
    }
    if (!this.handle) {
      this.lastTick = NaN;
      this.handle = this.host.requestFrame(this.tick);
    }
  }

  private stopLoop(): void {
    if (this.handle) this.host.cancelFrame(this.handle);
    this.handle = 0;
  }

  private setState(state: PlayState): void {
    if (state === this.st) return;
    this.st = state;
    this.host.onState?.(state);
  }

  private tick = (): void => {
    this.handle = 0;
    const t = this.host.now();
    if (!Number.isNaN(this.lastTick)) {
      const dt = t - this.lastTick;
      if (dt > 1 && dt < 100) this.frameMs += (dt - this.frameMs) * 0.1;
    }
    this.lastTick = t;

    if (this.st === 'buffering') {
      const d = this.host.duration(this.idx);
      if (d != null) {
        this.host.show(this.idx);
        this.deadline = t + d;
        this.setState('playing');
      }
    } else if (this.st === 'playing' && t >= this.deadline - this.frameMs / 2) {
      const next = Math.max(this.idx + 1, this.host.next?.(this.idx) ?? this.idx + 1);
      if (next >= this.host.wordCount()) {
        this.setState('ended');
        return;
      }
      this.idx = next;
      const d = this.host.duration(next);
      if (d == null) {
        this.setState('buffering');
      } else {
        this.host.show(next);
        const late = t - this.deadline;
        this.stats.record(late);
        this.deadline = late > RESYNC_MS ? t + d : this.deadline + d;
      }
    }

    if (this.running) this.handle = this.host.requestFrame(this.tick);
  };
}
