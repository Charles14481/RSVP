import { describe, expect, it } from 'vitest';
import { segment } from '../segment/segment';
import { groupEnd, groupText, maxPhraseChars } from './groups';
import { splitAtPivot, splitPhrase } from './orp';

/** All groups from the start, as text. */
function groups(text: string, size: number): string[] {
  const words = segment(text);
  const out: string[] = [];
  for (let i = 0; i < words.length; ) {
    const end = groupEnd(words, i, size);
    out.push(groupText(words, i, end));
    i = end;
  }
  return out;
}

describe('groupEnd', () => {
  it('shows one word at a time at size 1', () => {
    expect(groups('The cat sat on the mat.', 1)).toEqual(['The', 'cat', 'sat', 'on', 'the', 'mat.']);
  });

  it('fills groups up to the size', () => {
    expect(groups('The cat sat on the mat.', 3)).toEqual(['The cat sat', 'on the mat.']);
    expect(groups('The cat sat on the mat.', 2)).toEqual(['The cat', 'sat on', 'the mat.']);
  });

  it('ends a group at clause, sentence and paragraph ends', () => {
    expect(groups('Well, it rained. Then it stopped\n\nand we left', 3)).toEqual(['Well,', 'it rained.', 'Then it stopped', 'and we left']);
    expect(groups('one two \u2014 three four', 3)).toEqual(['one two \u2014', 'three four']);
  });

  it('keeps groups within the character limit, but always shows at least one word', () => {
    const long = 'internationalization'; // 20 characters
    expect(maxPhraseChars(2)).toBe(20);
    expect(groups(`${long} is hard`, 2)).toEqual([long, 'is hard']);
    expect(groups(`a ${long} b`, 2)).toEqual(['a', long, 'b']);
  });

  it('starts wherever reading starts', () => {
    const words = segment('The cat sat on the mat.');
    expect(groupText(words, 1, groupEnd(words, 1, 3))).toBe('cat sat on');
  });
});

describe('splitPhrase', () => {
  it('splits a single word exactly as splitAtPivot', () => {
    for (const w of ['a', 'cat', 'reading', '"quoted"', 'internationalization', '42%', '\u2014']) {
      expect(splitPhrase(w)).toEqual(splitAtPivot(w));
    }
  });

  it('pivots on the natural letter of the word under the middle', () => {
    expect(splitPhrase('on the mat')).toEqual({ left: 'on t', pivot: 'h', right: 'e mat' });
    // The middle falls in "elephant"; its pivot is the third letter.
    expect(splitPhrase('an elephant')).toEqual({ left: 'an el', pivot: 'e', right: 'phant' });
  });
});
