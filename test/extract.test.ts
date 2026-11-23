// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { extractPage, type PageText } from '../src/extension/extract';
import { normalizeChunk, normalizeText } from '../src/segment/segment';
import { STYLE } from '../src/types';

function page(body: string, title = 'Test page'): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`, 'text/html');
}

/** The whole visible text, skipping Readability. */
function readAll(doc: Document): PageText {
  return extractPage(doc, { layout: false, minArticleWords: Number.MAX_SAFE_INTEGER });
}

/** Every word's range in the page holds that word's chunk. */
function expectRangesMatch(p: PageText): void {
  const { words } = p;
  for (let i = 0; i < words.length; i++) {
    if (words[i].glued) continue;
    let chunk = words[i].text;
    for (let k = i + 1; k < words.length && words[k].glued; k++) chunk += words[k].text;
    const r = p.span(i, i + 1);
    expect(r, `range of word ${i}`).not.toBeNull();
    expect(normalizeChunk(r!.toString())).toContain(chunk);
  }
}

const filler = (n: number, seed: string) =>
  Array.from({ length: n }, (_, i) => `${seed}${i % 7 === 6 ? '.' : ''}`)
    .join(' ')
    .replace(/(^|\. )(\w)/g, (_, a, b: string) => a + b.toUpperCase());

describe('extractPage', () => {
  it('keeps paragraphs, joins words split across inline elements and records their ranges', () => {
    const p = readAll(page('<p>Hello <b>wor</b>ld, this <em>is</em> it.</p><div>Second <span>para</span>.</div>'));
    expect(p.text).toBe('Hello world, this is it.\n\nSecond para.');
    expect(p.span(1, 2)!.toString()).toBe('world,');
    expect(p.span(3, 4)!.toString()).toBe('is');
    expect(p.span(0, 3)!.toString()).toBe('Hello world, this');
    expect(p.format?.runs).toEqual([
      [1, 2, STYLE.bold],
      [3, 4, STYLE.italic],
    ]);
    expectRangesMatch(p);
    expect(p.source).toBe('page');
    expect(p.title).toBe('Test page');
  });

  it('normalizes like pasted text and skips what is not shown', () => {
    const doc = page(`
      <script>var x = "not text";</script><style>p { color: red }</style>
      <p>An oﬃce\u00A0with soft\u00ADhyphens and zero\u200Bwidth\u200B \u200B spaces.</p>
      <p hidden>Hidden paragraph.</p>
      <p>Line one<br>line two</p>
      <pre>code line 1
  code line 2

code line 3</pre>
      <p>See https://example.com/a/very/long/path/that-keeps-going/on-and-on for more.</p>
      <table><tr><td>Cell A</td><td>Cell B</td></tr></table>
      <ul><li>One</li><li>Two <code>x()</code></li></ul>`);
    const p = readAll(doc);
    expect(p.text.split('\n\n')).toEqual([
      'An office with softhyphens and zerowidth spaces.',
      'Line one',
      'line two',
      'code line 1',
      'code line 2',
      'code line 3',
      'See https://example.com/a/very/long/path/that-keeps-going/on-and-on for more.',
      'Cell A',
      'Cell B',
      'One',
      'Two x()',
    ]);
    expect(normalizeText(p.text)).toBe(p.text);
    expect(p.words.some((w) => w.glued)).toBe(true);
    expectRangesMatch(p);
    const code = p.words.find((w) => w.text === 'x()')!;
    expect(p.format?.runs.some(([s, e, b]) => s <= code.index && code.index < e && b & STYLE.code)).toBe(true);
  });

  it('reads only the selection', () => {
    const doc = page('<p id="a">First paragraph here.</p><p id="b">Second one, longer than that.</p>');
    const a = doc.getElementById('a')!.firstChild as Text;
    const b = doc.getElementById('b')!.firstChild as Text;
    const r = doc.createRange();
    r.setStart(a, 6); // "paragraph"
    r.setEnd(b, 10); // "Second one"
    const p = extractPage(doc, { layout: false, ranges: [r] });
    expect(p.source).toBe('selection');
    expect(p.text).toBe('paragraph here.\n\nSecond one');
    expectRangesMatch(p);
    // A selection that starts mid-word reads only the selected part.
    r.setStart(a, 8);
    expect(extractPage(doc, { layout: false, ranges: [r] }).text.startsWith('ragraph here.')).toBe(true);
  });

  it('finds words at points in the page', () => {
    const doc = page('<p>Alpha <i>be</i>ta gamma.</p><p>Delta.</p>');
    const p = readAll(doc);
    for (let i = 0; i < p.words.length; i++) {
      const r = p.span(i, i + 1)!;
      expect(p.wordAt(r.startContainer, r.startOffset, true)).toBe(i);
      expect(p.wordAt(r.endContainer, r.endOffset, true)).toBe(i);
    }
    const alpha = doc.querySelector('p')!.firstChild as Text; // "Alpha "
    // Inside "Alpha" and in the space after it.
    expect(p.wordAt(alpha, 2, true)).toBe(0);
    expect(p.wordAt(alpha, 6, true)).toBe(-1);
    expect(p.wordAt(alpha, 6)).toBe(1);
    // Before all text and after it.
    expect(p.wordAt(doc.body, 0)).toBe(0);
    expect(p.wordAt(doc.body, doc.body.childNodes.length)).toBe(p.words.length - 1);
  });

  it('reads the article and leaves out navigation and sidebars', () => {
    const doc = page(`
      <nav><a href="/">Home</a> <a href="/about">About us</a> <a href="/shop">Shop</a></nav>
      <div class="sidebar"><p>Subscribe to our newsletter for great deals today.</p></div>
      <article>
        <h1>The article title</h1>
        <p>${filler(120, 'lorem')}</p>
        <p>${filler(120, 'ipsum')}, with a <a href="https://x.example/">link inside</a> it.</p>
        <p>${filler(120, 'dolor')}</p>
      </article>
      <footer><p>Copyright notice and other footer text.</p></footer>`);
    const p = extractPage(doc, { layout: false });
    expect(p.source).toBe('article');
    expect(p.text).toContain('link inside it.');
    expect(p.text).not.toMatch(/newsletter|About us|Copyright/);
    expect(p.text.split('\n\n').length).toBeGreaterThanOrEqual(3);
    expectRangesMatch(p);
  });

  it('excludes the reader overlay and reports pages without text', () => {
    const doc = page('<div id="overlay">Overlay controls</div><p>Real text.</p>');
    const p = extractPage(doc, { layout: false, exclude: doc.getElementById('overlay'), minArticleWords: 1e9 });
    expect(p.text).toBe('Real text.');
    expect(() => readAll(page('<img src="x.png"><script>1</script>'))).toThrow(/no text/);
  });

  it('returns null for a word whose text has left the page', () => {
    const doc = page('<p>One two.</p><p id="gone">Three four.</p>');
    const p = readAll(doc);
    doc.getElementById('gone')!.remove();
    expect(p.span(0, 1)!.toString()).toBe('One');
    expect(p.span(2, 3)).toBeNull();
  });
});

describe('normalizeChunk', () => {
  it('matches normalizeText word for word', () => {
    expect(normalizeChunk('ﬁne')).toEqual(['fine']);
    expect(normalizeChunk('\u200B\u00AD')).toEqual([]);
    expect(normalizeChunk('a¨b')).toEqual(normalizeText('a¨b').split(' '));
  });
});
