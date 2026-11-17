import { describe, expect, it } from 'vitest';
import { chunksOf, isSentenceEnd, normalizeText, segment, segmentText, splitLongChunk, wordsToText } from './segment';
import { nextSentenceStart, paragraphRange, paragraphStart, previousSentenceStart, sentenceStart } from './nav';

const texts = (raw: string) => segmentText(raw).words.map((w) => w.text);

describe('normalizeText', () => {
  it('collapses whitespace runs and trims', () => {
    expect(normalizeText('  Hello \t  world  \n')).toBe('Hello world');
  });

  it('keeps blank-line paragraph breaks as exactly two newlines', () => {
    expect(normalizeText('One two.\r\n\r\n\r\n  Three four.')).toBe('One two.\n\nThree four.');
  });

  it('applies NFKC', () => {
    expect(normalizeText('ﬁne ｗｉｄｅ')).toBe('fine wide');
    expect(normalizeText('wait…')).toBe('wait...');
    expect(normalizeText('a\u00A0b')).toBe('a b');
  });

  it('removes invisible characters and control codes', () => {
    expect(normalizeText('co\u00ADoperate zero\u200Bwidth \uFEFFbom')).toBe('cooperate zerowidth bom');
    expect(normalizeText('a\u0000b\u000Cc')).toBe('a b c');
  });

  it('leaves only single spaces and paragraph breaks as whitespace', () => {
    const out = normalizeText('A\u2003b\u3000c\n \n\td  e\u2028f\u2029g');
    expect(out).not.toMatch(/[^\S \n]/);
    expect(out).not.toMatch(/ {2}| \n|\n /);
    expect(out.replace(/\n\n/g, '')).not.toContain('\n');
  });

  it('treats single newlines as paragraph breaks when lines are long', () => {
    const a = 'First paragraph. '.repeat(10).trim();
    const b = 'Second paragraph. '.repeat(10).trim();
    expect(normalizeText(`${a}\n${b}`)).toBe(`${a}\n\n${b}`);
  });

  it('rejoins hard-wrapped lines but keeps short lines apart', () => {
    const wrapped = [
      'Chapter One',
      '',
      'It was the best of times, it was the worst of times, it was the age of',
      'wisdom, it was the age of foolishness, it was the epoch of belief, it',
      'was the epoch of incredulity.',
      'A short line.',
    ].join('\n');
    expect(normalizeText(wrapped).split('\n\n')).toEqual([
      'Chapter One',
      'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness, it was the epoch of belief, it was the epoch of incredulity.',
      'A short line.',
    ]);
  });

  it('is idempotent', () => {
    const once = normalizeText('  A “quoted”\tline…\n\nAnother \u2014 one.\nAnd a third line here.  ');
    expect(normalizeText(once)).toBe(once);
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(normalizeText(' \n\t\n ')).toBe('');
    expect(segment('')).toEqual([]);
  });
});

describe('segment', () => {
  it('keeps punctuation attached to words', () => {
    expect(texts('However, the "end" (really) came.')).toEqual(['However,', 'the', '"end"', '(really)', 'came.']);
  });

  it('indexes words and paragraphs', () => {
    const { words } = segmentText('One two.\n\nThree.');
    expect(words.map((w) => w.index)).toEqual([0, 1, 2]);
    expect(words.map((w) => w.paragraphIndex)).toEqual([0, 0, 1]);
    expect(words.map((w) => w.paragraphEnd)).toEqual([false, true, true]);
  });

  it('marks the last word of every paragraph as a sentence end, punctuated or not', () => {
    const { words } = segmentText('A Heading\n\nBody text here');
    expect(words.filter((w) => w.sentenceEnd).map((w) => w.text)).toEqual(['Heading', 'here']);
  });

  it('round-trips through wordsToText', () => {
    const raw = 'See https://example.com/a/very/long-path/to/some-resource/index.html now.\n\nSecond “para”, with 3.14 and naïve café.';
    const { text, words } = segmentText(raw);
    expect(wordsToText(words)).toBe(text);
  });
});

describe('sentence ends', () => {
  const ends = (raw: string) =>
    segmentText(raw)
      .words.filter((w) => w.sentenceEnd)
      .map((w) => w.text);

  it('detects . ! ? with closing quotes and brackets', () => {
    expect(ends('He left. "Why?" she asked! (It rained.) Then “silence.” Done')).toEqual([
      'left.',
      '"Why?"',
      'asked!',
      'rained.)',
      '“silence.”',
      'Done',
    ]);
  });

  it('does not end sentences at titles and Latin abbreviations', () => {
    expect(ends('Dr. Smith met Mrs. Jones, e.g. on Monday, i.e. early. Fine.')).toEqual(['early.', 'Fine.']);
  });

  it('handles initials', () => {
    expect(ends('J. K. Rowling wrote it. Yes.')).toEqual(['it.', 'Yes.']);
  });

  it('uses the next word for ambiguous abbreviations', () => {
    expect(ends('Bring pens, paper, etc. and come. We have pens, etc. They work.')).toEqual(['come.', 'etc.', 'work.']);
    expect(ends('It opens at 9 a.m. on weekdays. It closes at 5 p.m. Nobody stays.')).toEqual([
      'weekdays.',
      'p.m.',
      'stays.',
    ]);
  });

  it('distinguishes "No. 5" from a plain "no."', () => {
    expect(ends('See No. 5 above. The answer is no. Sorry.')).toEqual(['above.', 'no.', 'Sorry.']);
  });

  it('does not end a sentence at a decimal number or a list marker', () => {
    expect(ends('Pi is 3.14 roughly. Done.')).toEqual(['roughly.', 'Done.']);
    expect(ends('1. First item here')).toEqual(['here']);
  });

  it('treats an ellipsis as a sentence end only before a capital', () => {
    expect(ends('Well... maybe not. Well... Maybe so.')).toEqual(['not.', 'Well...', 'so.']);
  });

  it('exposes the rule directly', () => {
    expect(isSentenceEnd('word', 'Next')).toBe(false);
    expect(isSentenceEnd('word.', undefined)).toBe(true);
    expect(isSentenceEnd('approx.', 'Five')).toBe(false);
    expect(isSentenceEnd('U.S.', 'policy')).toBe(false);
  });
});

describe('long chunks', () => {
  it('leaves short chunks alone', () => {
    expect(splitLongChunk('well-known')).toEqual(['well-known']);
    expect(splitLongChunk('antidisestablishmentarianism')).toEqual(['antidisestablishmentarianism']);
  });

  it('splits URLs and long compounds after hyphens and slashes', () => {
    const url = 'https://example.com/some/long-path/here';
    const pieces = splitLongChunk(url);
    expect(pieces.join('')).toBe(url);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(20);
    expect(splitLongChunk('state-of-the-art-machine-learning')).toEqual(['state-of-the-art-', 'machine-learning']);
  });

  it('does not strand trailing punctuation', () => {
    const pieces = splitLongChunk('mother-in-law-to-be-or-not-,');
    expect(pieces.join('')).toBe('mother-in-law-to-be-or-not-,');
    expect(pieces[pieces.length - 1]).toMatch(/[a-z]/);
  });

  it('marks continuation pieces as glued and puts flags on the last piece', () => {
    const { words } = segmentText('Visit https://example.com/some/long-path/here. Then leave.');
    const glued = words.filter((w) => w.glued);
    expect(glued.length).toBeGreaterThan(0);
    const lastPiece = words.find((w) => w.text.endsWith('here.'))!;
    expect(lastPiece.sentenceEnd).toBe(true);
    expect(words.filter((w) => w.sentenceEnd).length).toBe(2);
    const { chunks, first } = chunksOf(words);
    expect(chunks).toEqual(['Visit', 'https://example.com/some/long-path/here.', 'Then', 'leave.']);
    expect(first[first.length - 1]).toBe(words.length);
    expect(first[2]).toBe(lastPiece.index + 1);
  });
});

describe('navigation', () => {
  const { words } = segmentText('One two three. Four five. Six.\n\nSeven eight. Nine.');
  // indices:                       0   1   2      3    4     5        6     7      8

  it('finds sentence starts', () => {
    expect(sentenceStart(words, 0)).toBe(0);
    expect(sentenceStart(words, 2)).toBe(0);
    expect(sentenceStart(words, 4)).toBe(3);
    expect(sentenceStart(words, 7)).toBe(6);
  });

  it('moves to the next and previous sentence', () => {
    expect(nextSentenceStart(words, 1)).toBe(3);
    expect(nextSentenceStart(words, 5)).toBe(6);
    expect(nextSentenceStart(words, 8)).toBe(8);
    expect(previousSentenceStart(words, 4)).toBe(3);
    expect(previousSentenceStart(words, 3)).toBe(0);
    expect(previousSentenceStart(words, 0)).toBe(0);
    expect(previousSentenceStart(words, 4, 2)).toBe(0);
  });

  it('finds paragraph bounds', () => {
    expect(paragraphStart(words, 5)).toBe(0);
    expect(paragraphStart(words, 8)).toBe(6);
    expect(paragraphRange(words, 4)).toEqual([0, 6]);
    expect(paragraphRange(words, 6)).toEqual([6, 9]);
  });
});
