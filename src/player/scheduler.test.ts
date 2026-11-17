import { describe, expect, it } from 'vitest';
import { pivotOffset, splitAtPivot } from './orp';
import { Scheduler, type PlayState, type SchedulerHost } from './scheduler';

/** A fake display running at a fixed refresh rate with an injectable clock. */
function harness(durations: (number | null)[], frameMs = 1000 / 60) {
  let now = 1000.3;
  let pending: (() => void) | null = null;
  const onsets: { i: number; t: number }[] = [];
  const states: PlayState[] = [];
  const host: SchedulerHost = {
    now: () => now,
    requestFrame: (cb) => {
      pending = cb;
      return 1;
    },
    cancelFrame: () => {
      pending = null;
    },
    wordCount: () => durations.length,
    duration: (i) => durations[i],
    show: (i) => onsets.push({ i, t: now }),
    onState: (s) => states.push(s),
  };
  const scheduler = new Scheduler(host);
  /** Advance by n frames, optionally with jitter in frame timing. */
  const run = (frames: number, jitter: (k: number) => number = () => 0) => {
    for (let k = 0; k < frames && pending; k++) {
      now += frameMs + jitter(k);
      const cb = pending;
      pending = null;
      cb();
    }
  };
  return { scheduler, run, onsets, states, durations, advance: (ms: number) => (now += ms), isIdle: () => pending === null };
}

describe('Scheduler', () => {
  it('shows every word once, in order, then ends', () => {
    const h = harness([100, 150, 80, 200]);
    h.scheduler.play();
    h.run(1000);
    expect(h.onsets.map((o) => o.i)).toEqual([0, 1, 2, 3]);
    expect(h.scheduler.state).toBe('ended');
    expect(h.states).toEqual(['playing', 'ended']);
    expect(h.isIdle()).toBe(true);
  });

  it('keeps onset error under one frame with no drift', () => {
    const durations = Array.from({ length: 600 }, (_, i) => 80 + ((i * 37) % 211) + 0.37);
    const frameMs = 1000 / 60;
    const h = harness(durations, frameMs);
    h.scheduler.play();
    h.run(1e6, (k) => ((k * 7919) % 5) * 0.2 - 0.4);
    expect(h.onsets.length).toBe(600);

    const t0 = h.onsets[0].t;
    let ideal = t0;
    let sumAbs = 0;
    for (let i = 1; i < h.onsets.length; i++) {
      ideal += durations[i - 1];
      const err = h.onsets[i].t - ideal;
      sumAbs += Math.abs(err);
      // No accumulation: the 600th word is as close to its ideal onset as the 1st.
      expect(Math.abs(err)).toBeLessThan(frameMs);
    }
    expect(sumAbs / (h.onsets.length - 1)).toBeLessThan(frameMs / 2);
    expect(h.scheduler.stats.count).toBe(599);
    expect(h.scheduler.stats.meanAbs).toBeLessThan(frameMs / 2);
    expect(h.scheduler.stats.maxAbs).toBeLessThan(frameMs);
  });

  it('holds the same bound at 144 Hz and 30 Hz', () => {
    for (const hz of [30, 144]) {
      const frameMs = 1000 / hz;
      const durations = Array.from({ length: 200 }, (_, i) => 90 + ((i * 53) % 170));
      const h = harness(durations, frameMs);
      h.scheduler.play();
      h.run(1e6);
      expect(h.onsets.length).toBe(200);
      expect(h.scheduler.stats.meanAbs).toBeLessThan(frameMs);
    }
  });

  it('pauses and resumes on the same word', () => {
    const h = harness([100, 100, 100, 100]);
    h.scheduler.play();
    h.run(8);
    h.scheduler.pause();
    const at = h.scheduler.index;
    expect(h.scheduler.state).toBe('paused');
    expect(h.isIdle()).toBe(true);
    h.advance(5000);
    h.scheduler.play();
    expect(h.scheduler.index).toBe(at);
    h.run(1000);
    expect(h.scheduler.state).toBe('ended');
  });

  it('buffers at an untimed word and resumes when it becomes available', () => {
    const h = harness([100, null, 100]);
    h.scheduler.play();
    h.run(30);
    expect(h.scheduler.state).toBe('buffering');
    expect(h.scheduler.index).toBe(1);
    expect(h.onsets.map((o) => o.i)).toEqual([0]);
    h.durations[1] = 120;
    h.run(1);
    expect(h.scheduler.state).toBe('playing');
    expect(h.onsets.map((o) => o.i)).toEqual([0, 1]);
    const shownAt = h.onsets[1].t;
    h.run(1000);
    // The buffered word still gets its full duration.
    expect(h.onsets[2].t - shownAt).toBeGreaterThan(120 - 17);
    expect(h.states).toEqual(['playing', 'buffering', 'playing', 'ended']);
  });

  it('buffers immediately if the first word is untimed', () => {
    const h = harness([null, 100]);
    h.scheduler.play();
    expect(h.scheduler.state).toBe('buffering');
    expect(h.onsets).toEqual([]);
  });

  it('seeks while paused and while playing', () => {
    const h = harness([100, 100, 100, 100, 100]);
    h.scheduler.seek(3);
    expect(h.scheduler.index).toBe(3);
    expect(h.onsets.map((o) => o.i)).toEqual([3]);
    expect(h.scheduler.state).toBe('paused');
    h.scheduler.play();
    h.run(3);
    h.scheduler.seek(1);
    expect(h.scheduler.state).toBe('playing');
    h.run(1000);
    expect(h.onsets.map((o) => o.i)).toEqual([3, 3, 1, 2, 3, 4]);
  });

  it('clamps seeks to the document', () => {
    const h = harness([100, 100]);
    h.scheduler.seek(99);
    expect(h.scheduler.index).toBe(1);
    h.scheduler.seek(-5);
    expect(h.scheduler.index).toBe(0);
  });

  it('restarts from the beginning when played after the end', () => {
    const h = harness([100, 100]);
    h.scheduler.play();
    h.run(1000);
    expect(h.scheduler.state).toBe('ended');
    h.scheduler.play();
    expect(h.scheduler.index).toBe(0);
    expect(h.scheduler.state).toBe('playing');
  });

  it('restarts the clock after a long stall instead of rushing', () => {
    const h = harness([100, 100, 100, 100]);
    h.scheduler.play();
    h.run(2);
    h.advance(3000);
    h.run(1);
    expect(h.scheduler.index).toBe(1);
    h.run(3);
    expect(h.scheduler.index).toBe(1);
    h.run(4);
    expect(h.scheduler.index).toBe(2);
  });

  it('does nothing on an empty document', () => {
    const h = harness([]);
    h.scheduler.play();
    expect(h.scheduler.state).toBe('paused');
  });
});

describe('ORP pivot', () => {
  it('maps letter count to pivot offset', () => {
    const offsets = [1, 2, 5, 6, 9, 10, 13, 14, 30].map(pivotOffset);
    expect(offsets).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it('splits words around the pivot', () => {
    expect(splitAtPivot('a')).toEqual({ left: '', pivot: 'a', right: '' });
    expect(splitAtPivot('reading')).toEqual({ left: 're', pivot: 'a', right: 'ding' });
    expect(splitAtPivot('understanding')).toEqual({ left: 'und', pivot: 'e', right: 'rstanding' });
  });

  it('ignores leading punctuation and does not count punctuation as letters', () => {
    expect(splitAtPivot('“Hello,”')).toEqual({ left: '“H', pivot: 'e', right: 'llo,”' });
    expect(splitAtPivot('(a)')).toEqual({ left: '(', pivot: 'a', right: ')' });
  });

  it('handles punctuation-only and empty strings', () => {
    expect(splitAtPivot('\u2014')).toEqual({ left: '', pivot: '\u2014', right: '' });
    expect(splitAtPivot('')).toEqual({ left: '', pivot: '', right: '' });
  });
});
