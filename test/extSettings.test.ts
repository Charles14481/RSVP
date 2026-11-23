import { describe, expect, it } from 'vitest';
import { DEFAULT_EXT, mergeExt } from '../src/extension/settings';

describe('mergeExt', () => {
  it('fills defaults', () => {
    expect(mergeExt(undefined)).toEqual(DEFAULT_EXT);
    expect(mergeExt({ display: 'nonsense', follow: 'yes' })).toEqual(DEFAULT_EXT);
  });

  it('carries the earlier sentence on/off setting over to the highlight mode', () => {
    expect(mergeExt({ highlightSentence: false }).highlight).toBe('word');
    expect(mergeExt({ highlightSentence: true }).highlight).toBe('both');
    expect(mergeExt({ highlightSentence: false, highlight: 'sentence' }).highlight).toBe('sentence');
  });

  it('keeps a dragged position only with valid coordinates, clamped to the window', () => {
    expect(mergeExt({ position: 'custom', at: { x: 0.25, y: 1.4 } })).toMatchObject({ position: 'custom', at: { x: 0.25, y: 1 } });
    expect(mergeExt({ position: 'custom' }).position).toBe('top');
    expect(mergeExt({ position: 'custom', at: { x: 'a', y: 0 } }).position).toBe('top');
  });

  it('turns keep-open on only when stored as true', () => {
    expect(mergeExt({ keepOpen: true }).keepOpen).toBe(true);
    expect(mergeExt({ keepOpen: 'true' }).keepOpen).toBe(false);
  });
});
