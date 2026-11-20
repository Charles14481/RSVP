// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { htmlHasFormatting, htmlStringToMarkdown } from '../src/ingest/html';
import { markdownToDoc } from '../src/ingest/markdown';
import { WordStyles } from '../src/segment/format';
import { segment } from '../src/segment/segment';
import { STYLE } from '../src/types';

/** HTML through Markdown to the reader's text and styles. */
function roundTrip(html: string) {
  const md = htmlStringToMarkdown(html);
  const { text, format } = markdownToDoc(md);
  const words = segment(text);
  const styles = WordStyles.from(format, words);
  return {
    md,
    text,
    styled: (bit: number) => words.filter((w) => (styles?.bitsOf(w.index) ?? 0) & bit).map((w) => w.text),
    block: (p: number) => styles?.block(p),
    link: (word: string) => styles?.href(words.find((w) => w.text === word)!.index),
  };
}

describe('htmlStringToMarkdown', () => {
  it('converts the common block and inline elements', () => {
    const r = roundTrip(`
      <h2>Heading</h2>
      <p>Some <strong>bold</strong>, <em>italic</em> and <code>code</code> with <a href="https://x.example/">a link</a>.</p>
      <ul><li>One</li><li>Two<ol><li>Inner</li></ol></li></ul>
      <blockquote><p>Quote</p></blockquote>
      <pre>line 1
line 2</pre>
      <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>`);
    expect(r.md).toMatch(/^## Heading$/m);
    expect(r.text.split('\n\n')).toEqual(['Heading', 'Some bold, italic and code with a link.', 'One', 'Two', '1. Inner', 'Quote', 'line 1', 'line 2', 'A; B', '1; 2']);
    expect(r.styled(STYLE.bold)).toEqual(['bold,']);
    expect(r.styled(STYLE.italic)).toEqual(['italic']);
    expect(r.styled(STYLE.code)).toEqual(['code']);
    expect(r.link('link.')).toBe('https://x.example/');
    expect(r.block(0)).toEqual({ kind: 'h2' });
    expect(r.block(2)).toEqual({ kind: 'li', depth: 0 });
    expect(r.block(4)).toEqual({ kind: 'li', depth: 1, ordered: true });
    expect(r.block(5)).toEqual({ kind: 'quote' });
    expect(r.block(6)).toEqual({ kind: 'code' });
    expect(r.block(8)).toEqual({ kind: 'th' });
  });

  it('keeps literal text literal: Markdown syntax in the source is escaped', () => {
    const plain = '2 * 3 = 6, snake_case, [x](y), `tick` and <tag> ~ok~ &amp;';
    const r = roundTrip(`<p>${plain.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p><p># not a heading</p><p>1. not a list</p><p>- nor this</p>`);
    expect(r.text.split('\n\n')).toEqual([plain, '# not a heading', '1. not a list', '- nor this']);
    expect(r.block(1)).toBeUndefined();
    expect(r.block(2)).toBeUndefined();
  });

  it('reads Google Docs and Word style spans', () => {
    const r = roundTrip(
      '<b style="font-weight:normal;" id="docs-internal-guid-1"><p><span style="font-weight:400">Plain </span><span style="font-weight:700">heavy</span><span style="font-style:italic"> slanted</span></p></b>',
    );
    expect(r.text).toBe('Plain heavy slanted');
    expect(r.styled(STYLE.bold)).toEqual(['heavy']);
    expect(r.styled(STYLE.italic)).toEqual(['slanted']);
  });

  it('moves whitespace outside emphasis so it stays valid', () => {
    expect(htmlStringToMarkdown('<p><strong>bold </strong>text <em> it </em>end</p>')).toBe('**bold** text *it* end');
  });

  it('turns <br> into a line break and drops scripts, images and unsafe links', () => {
    const r = roundTrip('<p>one<br>two <img src=x onerror="window.evil=1"><script>window.evil=2</script><a href="javascript:alert(1)">click</a></p>');
    expect(r.text).toBe('one\n\ntwo click');
    expect(r.link('click')).toBeUndefined();
    expect((window as unknown as { evil?: number }).evil).toBeUndefined();
  });
});

describe('htmlHasFormatting', () => {
  it('tells rich HTML from plain HTML', () => {
    expect(htmlHasFormatting('<meta charset="utf-8"><b>x</b>')).toBe(true);
    expect(htmlHasFormatting('<a href="https://x.example/">x</a>')).toBe(true);
    expect(htmlHasFormatting('<span style="font-weight:700">x</span>')).toBe(true);
    expect(htmlHasFormatting('<meta charset="utf-8"><div>just text</div>')).toBe(false);
  });
});
