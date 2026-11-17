import { describe, expect, it } from 'vitest';
import { planWindow, type Window } from './windows';

/** Run the planner to completion, marking targets as scored. */
function planAll(N: number, W: number, S: number, cursor = 1, pre?: (s: Uint8Array) => void): Window[] {
  const scored = new Uint8Array(N);
  scored[0] = 1;
  pre?.(scored);
  const out: Window[] = [];
  const hint = { pos: 0 };
  for (let guard = 0; guard < 10000; guard++) {
    const w = planWindow(scored, W, S, cursor, hint);
    if (!w) return out;
    out.push(w);
    for (let j = w.from; j <= w.to; j++) scored[j] = 1;
  }
  throw new Error('planner did not terminate');
}

describe('planWindow', () => {
  it('scores every target exactly once with at least W - S context', () => {
    for (const [N, W, S] of [
      [2, 512, 256],
      [100, 512, 256],
      [513, 512, 256],
      [3000, 512, 256],
      [3000, 256, 128],
      [1001, 100, 100],
      [777, 64, 7],
    ]) {
      const count = new Uint8Array(N);
      for (const w of planAll(N, W, S)) {
        expect(w.end - w.start).toBeLessThanOrEqual(W);
        expect(w.end).toBe(w.to);
        expect(w.to).toBeLessThan(N);
        for (let j = w.from; j <= w.to; j++) {
          count[j]++;
          // Context for target j is tokens [start, j): all of them from BOS, or at least W - S.
          const context = j - w.start;
          if (w.start > 0) expect(context).toBeGreaterThanOrEqual(W - S + 1);
        }
      }
      expect(count[0]).toBe(0);
      for (let j = 1; j < N; j++) expect(count[j]).toBe(1);
    }
  });

  it('matches the plan: first window W tokens, then windows advancing by S', () => {
    const wins = planAll(1200, 512, 256);
    expect(wins.map((w) => [w.start, w.end])).toEqual([
      [0, 512],
      [256, 768],
      [512, 1024],
      [687, 1199],
    ]);
    expect(wins.map((w) => [w.from, w.to])).toEqual([
      [1, 512],
      [513, 768],
      [769, 1024],
      [1025, 1199],
    ]);
  });

  it('starts at the cursor, runs to the end, then wraps to the beginning', () => {
    const wins = planAll(2000, 512, 256, 1500);
    expect(wins[0].from).toBe(1500);
    expect(wins[0].start).toBe(1500 - 1 + 256 - 512);
    const firstWrapped = wins.findIndex((w) => w.from < 1500);
    expect(wins[firstWrapped - 1].to).toBe(1999);
    expect(wins[firstWrapped]).toMatchObject({ start: 0, from: 1 });
  });

  it('skips targets that are already scored', () => {
    const wins = planAll(1000, 128, 64, 1, (s) => s.fill(1, 1, 600));
    expect(wins[0].from).toBe(600);
  });

  it('returns null when nothing is left or the document is too short', () => {
    expect(planWindow(new Uint8Array([1]), 512, 256)).toBeNull();
    expect(planWindow(new Uint8Array([1, 1, 1]), 512, 256)).toBeNull();
  });

  it('rejects a stride larger than the window', () => {
    expect(() => planWindow(new Uint8Array(10), 4, 8)).toThrow();
  });
});
