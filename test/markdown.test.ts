import { describe, expect, it } from 'vitest';
import { convertText, decodeEntities, looksLikeMarkdown, markdownToDoc, repairEmphasis } from '../src/ingest/markdown';
import { WordStyles, groupBits } from '../src/segment/format';
import { normalizeText, segment } from '../src/segment/segment';
import { STYLE, type DocFormat } from '../src/types';

const SNIPPET = `__Induction Heads/Circuits ... First described in [A Mathematical Framework](https://transformer-circuits.pub/2021/framework/index.html) and enough of a big deal that we then wrote [an entire other paper on them](https://transformer-circuits.pub/2022/in-context-learning-and-induction-heads/index.html). Check out [my walkthrough with Charles Frye](https://www.youtube.com/watch?v=dCkQQYwPxdM) on that paper for a more accessible introduction.__
    The **induction behaviour/task**:`;

/** Words with their style bits, link and paragraph style, for compact assertions. */
function view(src: string) {
  const { text, format } = markdownToDoc(src);
  const words = segment(text);
  const styles = WordStyles.from(format, words);
  return {
    text,
    format,
    words,
    paragraphs: text.split('\n\n'),
    styled: (bit: number) => words.filter((w) => (styles?.bitsOf(w.index) ?? 0) & bit).map((w) => w.text),
    link: (word: string) => styles?.href(words.find((w) => w.text === word)!.index),
    block: (p: number) => styles?.block(p),
  };
}

describe('markdownToDoc', () => {
  it('reads the pasted snippet as prose with bold and links, without any syntax', () => {
    const v = view(SNIPPET);
    expect(v.paragraphs).toEqual([
      'Induction Heads/Circuits ... First described in A Mathematical Framework and enough of a big deal that we then wrote an entire other paper on them. Check out my walkthrough with Charles Frye on that paper for a more accessible introduction.',
      'The induction behaviour/task:',
    ]);
    expect(v.text).not.toMatch(/[_*[\]()]|https?:/);
    expect(v.styled(STYLE.bold)).toContain('introduction.');
    expect(v.styled(STYLE.bold)).toEqual(expect.arrayContaining(['Induction', 'induction', 'behaviour/task:']));
    expect(v.styled(STYLE.bold)).not.toContain('The');
    expect(v.link('Mathematical')).toBe('https://transformer-circuits.pub/2021/framework/index.html');
    expect(v.link('Frye')).toBe('https://www.youtube.com/watch?v=dCkQQYwPxdM');
    expect(v.link('Check')).toBeUndefined();
  });

  it('reads emphasis whose delimiters have a space on the inside, as note apps export it', () => {
    const v = view('**Anti-induction heads: **A variant that has the same attention pattern, but __suppresses __the token attended to.');
    expect(v.text).toBe('Anti-induction heads: A variant that has the same attention pattern, but suppresses the token attended to.');
    expect(v.styled(STYLE.bold)).toEqual(['Anti-induction', 'heads:', 'suppresses']);
    expect(view('a word** bold** here and *it *x').styled(STYLE.bold)).toEqual(['bold']);
    expect(view('a word** bold** here and *it *x').styled(STYLE.italic)).toEqual(['it']);
  });

  it('leaves alone what only looks like misplaced emphasis', () => {
    for (const src of ['2 ** 3 ** 4 is a power', 'snake_case and __init__ names', 'a * b * c', '`**code **x`']) {
      expect(repairEmphasis(src)).toBe(src);
    }
    expect(repairEmphasis('* item with *emphasis*')).toBe('* item with *emphasis*');
    expect(repairEmphasis('```\n**a **b\n```')).toBe('```\n**a **b\n```');
    expect(repairEmphasis('**fine** and **also fine**')).toBe('**fine** and **also fine**');
  });

  it('produces normalized text, so the reader and the cache see exactly what was saved', () => {
    for (const src of [SNIPPET, '# T\n\n- a\n- b\n\n> q', 'caf**é** and *x*', '`a  b`  c\n\n\n\nd']) {
      const { text } = markdownToDoc(src);
      expect(normalizeText(text)).toBe(text);
    }
    expect(markdownToDoc('caf**é**').text).toBe('café');
  });

  it('keeps headings, lists, quotes, code and tables as paragraph styles', () => {
    const v = view(`# Title

Intro *text* with \`code\` and ~~old~~.

1. First
2. Second
   - Nested

> Quoted

\`\`\`
let x = 1;

let y = 2;
\`\`\`

| Name | Score |
|------|-------|
| Ada  | 3     |
`);
    expect(v.paragraphs).toEqual(['Title', 'Intro text with code and old.', '1. First', '2. Second', 'Nested', 'Quoted', 'let x = 1;', 'let y = 2;', 'Name; Score', 'Ada; 3']);
    expect(v.block(0)).toEqual({ kind: 'h1' });
    expect(v.block(1)).toBeUndefined();
    expect(v.block(2)).toEqual({ kind: 'li', depth: 0, ordered: true });
    expect(v.block(4)).toEqual({ kind: 'li', depth: 1 });
    expect(v.block(5)).toEqual({ kind: 'quote' });
    expect(v.block(6)).toEqual({ kind: 'code' });
    expect(v.block(8)).toEqual({ kind: 'th' });
    expect(v.block(9)).toEqual({ kind: 'tr' });
    expect(v.styled(STYLE.italic)).toEqual(['text']);
    expect(v.styled(STYLE.code)).toEqual(['code']);
    expect(v.styled(STYLE.strike)).toEqual(['old.']);
  });

  it('gives every line of a list item or quote its block style when lines become paragraphs', () => {
    // Lines over 100 characters, so the text is not taken for hard-wrapped and each line stays a paragraph.
    const long = (s: string) => `${s} ${'and so on '.repeat(10).trim()}`;
    const v = view(`- ${long('first')}\n  ${long('second')}\n\n> ${long('one')}\n> ${long('two')}`);
    expect(v.paragraphs.map((p) => p.split(' ')[0])).toEqual(['first', 'second', 'one', 'two']);
    expect(v.block(0)).toEqual({ kind: 'li', depth: 0 });
    expect(v.block(1)).toEqual({ kind: 'li', depth: 0, cont: true });
    expect(v.block(2)).toEqual({ kind: 'quote' });
    expect(v.block(3)).toEqual({ kind: 'quote' });
  });

  it('rejoins hard-wrapped paragraphs like a plain-text import', () => {
    const wrapped = 'This paragraph was wrapped by an editor at a fixed\nwidth so every line is nearly full and none of the\nlines should become a paragraph of its own here.';
    expect(view(wrapped).paragraphs).toHaveLength(1);
  });

  it('understands simple inline HTML and closes what it leaves open', () => {
    const v = view('a <b>bold</b> and <a href="https://x.example/">linked</a> <i>open\n\nnext');
    expect(v.styled(STYLE.bold)).toEqual(['bold']);
    expect(v.link('linked')).toBe('https://x.example/');
    expect(v.styled(STYLE.italic)).toEqual(['open']);
  });

  it('keeps only links that are safe to open', () => {
    const v = view('[bad](javascript:alert(1)) [mail](mailto:a@b.example) [rel](/x)');
    expect(v.text).toBe('bad mail rel');
    expect(v.link('bad')).toBeUndefined();
    expect(v.link('mail')).toBe('mailto:a@b.example');
    expect(v.link('rel')).toBeUndefined();
  });

  it('decodes entities and honours escapes', () => {
    expect(view('Fish &amp; chips &mdash; &#8220;yum&#x201D; \\*not bold\\*').text).toBe('Fish & chips \u2014 “yum” *not bold*');
    expect(decodeEntities('&bogus; &#0;')).toBe('&bogus; �');
  });

  it('drops images, rules and link definitions', () => {
    expect(view('Text ![alt](https://x.example/i.png) more\n\n---\n\n[r]: https://x.example/').text).toBe('Text more');
  });

  it('cannot be confused by private-use characters in the input', () => {
    const v = view('ab\u{F0000}c **d**');
    expect(v.text).toBe('abc d');
    expect(v.styled(STYLE.bold)).toEqual(['d']);
  });

  it('returns no format for text without any', () => {
    expect(markdownToDoc('Just a plain sentence.\n\nAnd another.')).toEqual({ text: 'Just a plain sentence.\n\nAnd another.', format: null });
    expect(markdownToDoc('')).toEqual({ text: '', format: null });
  });

  it('styles a long split chunk on every piece', () => {
    const v = view('**https://example.com/a-very/long-path/that-gets-split**');
    expect(v.words.length).toBeGreaterThan(1);
    expect(v.styled(STYLE.bold)).toHaveLength(v.words.length);
  });
});

describe('convertText', () => {
  it('leaves plain text alone', () => {
    expect(convertText('**not** [markdown](x)', 'plain')).toEqual({ text: '**not** [markdown](x)', format: null });
  });
});

describe('looksLikeMarkdown', () => {
  it('spots links, emphasis, headings, fences and tables', () => {
    expect(looksLikeMarkdown(SNIPPET)).toBe(true);
    expect(looksLikeMarkdown('# Notes\n\nSome text.')).toBe(true);
    expect(looksLikeMarkdown('Some **bold** words.')).toBe(true);
    expect(looksLikeMarkdown('**Anti-induction heads: **A variant, but __suppresses __the token.')).toBe(true);
    expect(looksLikeMarkdown('```\ncode\n```')).toBe(true);
    expect(looksLikeMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(true);
  });

  it('does not take ordinary prose for Markdown', () => {
    expect(looksLikeMarkdown('It costs 2 * 3 dollars. Email me at a_b@c.example.')).toBe(false);
    expect(looksLikeMarkdown('Shopping:\n- eggs\n- milk')).toBe(false);
    expect(looksLikeMarkdown('Chapter 1\n\nIt was a dark and stormy night.')).toBe(false);
  });
});

describe('WordStyles', () => {
  it('ignores ranges outside the text', () => {
    const words = segment('one two');
    const format: DocFormat = { v: 1, runs: [[1, 99, STYLE.bold]], links: [[-5, 1, 'https://x.example/']], blocks: [[7, { kind: 'h1' }]] };
    const s = WordStyles.from(format, words)!;
    expect([s.bitsOf(0), s.bitsOf(1)]).toEqual([0, STYLE.bold]);
    expect(s.href(0)).toBe('https://x.example/');
    expect(s.block(7)).toBeUndefined();
  });

  it('styles a flashed phrase only with what all its words share; headings are bold', () => {
    const v = markdownToDoc('# Big title\n\n**a** *b c*');
    const words = segment(v.text);
    const s = WordStyles.from(v.format, words);
    expect(groupBits(s, words, 0, 2)).toBe(STYLE.bold);
    expect(groupBits(s, words, 2, 4)).toBe(0);
    expect(groupBits(s, words, 3, 5)).toBe(STYLE.italic);
  });
});
