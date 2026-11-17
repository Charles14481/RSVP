import { beforeAll, describe, expect, it } from 'vitest';
import { chunksOf, normalizeText, segment } from '../src/segment/segment';
import { alignText, AlignmentError, groupTokens, verifyAlignment, type TokenizerLike } from '../src/surprisal/align';
import { PASSAGES, passage } from './helpers/fixtures';
import { gpt2Tokenizer } from './helpers/tokenizer';

let tok: TokenizerLike;
beforeAll(async () => {
  tok = await gpt2Tokenizer();
});

/** Normalize, segment, align and check the full invariant. Returns the pieces for inspection. */
function check(raw: string) {
  const text = normalizeText(raw);
  const words = segment(text);
  const { chunks } = chunksOf(words);
  const al = alignText(tok, text);
  verifyAlignment(al, chunks, tok, true);
  expect(al.groupCount).toBe(chunks.length);
  return { text, words, chunks, al };
}

describe('groupTokens', () => {
  it('starts words at leading spaces and after whitespace-only tokens', () => {
    const pieces = ['<s>', 'Hello', ',', ' world', '.', '\n', '\n', 'Next', ' one'];
    const g = groupTokens(pieces, (i) => i === 0);
    expect(Array.from(g.groupOf)).toEqual([-1, 0, 0, 1, 1, -1, -1, 2, 3]);
    expect(Array.from(g.groupStart)).toEqual([1, 3, 7, 8]);
    expect(Array.from(g.groupEnd)).toEqual([3, 5, 8, 9]);
  });

  it('treats a standalone space token as a break', () => {
    const g = groupTokens(['a', ' ', 'b']);
    expect(Array.from(g.groupOf)).toEqual([0, -1, 1]);
  });
});

describe('alignment invariant with the GPT-2 tokenizer', () => {
  it('prepends BOS and keeps it out of every group', () => {
    const { al } = check('Hello there.');
    expect(al.ids[0]).toBe(50256);
    expect(al.groupOf[0]).toBe(-1);
  });

  it.each(PASSAGES)('holds on the %s fixture', (name) => {
    const text = passage(name);
    expect(normalizeText(text)).toBe(text);
    const { chunks, al } = check(text);
    expect(chunks.length).toBeGreaterThan(50);
    // Whitespace-only tokens appear exactly at paragraph breaks.
    const paragraphs = text.split('\n\n').length;
    const newlineTokens = Array.from(al.groupOf).filter((g, i) => g < 0 && i > 0).length;
    expect(newlineTokens).toBe(2 * (paragraphs - 1));
  });

  it.each([
    ['punctuation', 'Wait... what?! (Really.) "Yes," she said; \'no\' -- maybe: fine.'],
    ['contractions', "Don't you'd've thought it's the dogs' bone? I'm sure they'll say y'all."],
    ['numbers', 'In 1999, 3.14159 and 1,000,000 and -42 and 50% and 2nd and 10:30 and 1/2 and #7.'],
    ['curly quotes and dashes', '“Quoted” and ‘single’ \u2014 em dash \u2013 en dash … ellipsis.'],
    ['accents and ligatures', 'Naïve café façade Brontë ﬁnancial résumé São Paulo Zürich.'],
    ['non-Latin scripts', 'Ελληνικά Кириллица עברית العربية हिन्दी 日本語のテキスト 한국어'],
    ['emoji', 'Thumbs 👍🏽 up, family 👨\u200D👩\u200D👧, flag 🇫🇷 and ❤️ hearts.'],
    ['combining marks', 'été and ñ and å.'],
    ['symbols', 'C++ and C# and @user and $5 and €20 and ~/path and a|b and x^2 and <tag>.'],
    ['paragraph breaks', 'First paragraph.\n\nSecond one starts here.\n\n\n\n"Third," with a quote.'],
    ['paragraph starting with punctuation', 'Intro.\n\n(Aside.)\n\n\u2014 Dash start.\n\n...ellipsis start'],
    ['long chunks split for display', 'See https://example.com/a/very/long-path/with-many-parts/index.html now, or state-of-the-art-machine-learning.'],
    ['tabs and odd spaces', 'a\tb\u00A0c\u2003d\u3000e'],
    ['single word', 'Hi'],
    ['digits glued to letters', 'COVID-19 B2B mp3 4K 3D H2O x86_64'],
  ])('holds for %s', (_, raw) => {
    check(raw);
  });

  it('reports the first mismatching word when the counts differ', () => {
    const text = 'One two three.';
    const al = alignText(tok, text);
    expect(() => verifyAlignment(al, ['One', 'two'], tok, false)).toThrow(AlignmentError);
    try {
      verifyAlignment(al, ['One', 'too', 'three.'], tok, true);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AlignmentError);
      expect((e as AlignmentError).detail).toMatchObject({ chunkIndex: 1, expected: 'too', actual: 'two' });
    }
  });

  it('tokenizes paragraph breaks as two newline tokens', () => {
    const al = alignText(tok, 'a.\n\nB');
    expect(Array.from(al.ids)).toEqual([50256, 64, 13, 198, 198, 33]);
  });
});
