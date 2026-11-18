import { describe, expect, it } from 'vitest';
import { rowLogProb, topPredictions } from './logprob';

describe('topPredictions', () => {
  it('returns the k most probable tokens in order, with probabilities that match softmax', () => {
    const row = [0.5, 3, -1, 2.5, 3, 0];
    const { top, target } = topPredictions(row, 0, row.length, 3, 2);
    expect(top.map((t) => t.id)).toEqual([1, 4, 3]);
    for (const t of top) expect(Math.log(t.p)).toBeCloseTo(rowLogProb(row, 0, row.length, t.id), 10);
    expect(target.rank).toBe(6);
    expect(Math.log(target.p)).toBeCloseTo(rowLogProb(row, 0, row.length, 2), 10);
  });

  it('reads the row at an offset and handles k larger than the vocabulary', () => {
    const data = [9, 9, 9, 1, 4, 2];
    const { top, target } = topPredictions(data, 3, 3, 10, 1);
    expect(top.map((t) => t.id)).toEqual([1, 2, 0]);
    expect(top.reduce((s, t) => s + t.p, 0)).toBeCloseTo(1, 12);
    expect(target).toEqual({ p: top[0].p, rank: 1 });
  });
});
