// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { blocksToText, decodeHtml, detectCharset, extractArticle, UrlImportError } from '../src/ingest/url';

const para = (n: number) =>
  `Paragraph ${n} of the article discusses an idea at some length, adding detail after detail so that the extractor recognizes real prose rather than navigation or boilerplate text.`;

const PAGE = `<!doctype html><html><head><title>The Title | Example News</title>
<meta property="og:site_name" content="Example News"></head><body>
<nav><a href="/">Home</a> <a href="/world">World</a> <a href="/sport">Sport</a></nav>
<header><h1>Site header</h1></header>
<article>
  <h1>The Title</h1>
  <p class="byline">By Ada Writer</p>
  <p>${para(1)}</p>
  <p>${para(2)} It has <em>emphasis</em>, <a href="/x">a link</a> and a line<br>break.</p>
  <script>window.evil = 1; document.body.innerHTML = 'pwned';</script>
  <h2>A subheading</h2>
  <p>${para(3)}</p>
  <ul><li>First point in a list.</li><li>Second point in a list.</li></ul>
  <blockquote><p>${para(4)}</p></blockquote>
  <img src="x" onerror="window.evil = 2">
  <p>${para(5)}</p>
</article>
<footer>Copyright 2026. All rights reserved. Privacy. Terms.</footer>
</body></html>`;

describe('charset detection', () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  it('prefers the header, then BOM, then meta, then UTF-8', () => {
    expect(detectCharset('text/html; charset=ISO-8859-1', bytes('<meta charset="utf-8">'))).toBe('ISO-8859-1');
    expect(detectCharset(null, Uint8Array.from([0xef, 0xbb, 0xbf, 0x41]))).toBe('utf-8');
    expect(detectCharset('text/html', bytes('<html><head><meta charset="windows-1252">'))).toBe('windows-1252');
    expect(detectCharset('text/html', bytes('<meta http-equiv="Content-Type" content="text/html; charset=shift_jis">'))).toBe('shift_jis');
    expect(detectCharset(null, bytes('<html>'))).toBe('utf-8');
  });

  it('decodes legacy encodings and survives unknown labels', () => {
    expect(decodeHtml(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), 'text/html; charset=windows-1252')).toBe('café');
    expect(decodeHtml(new TextEncoder().encode('naïve'), 'text/html; charset=bogus-charset')).toBe('naïve');
  });
});

describe('blocksToText', () => {
  it('makes one paragraph per block and keeps inline text together', () => {
    const doc = new DOMParser().parseFromString(
      '<div>Loose <b>inline</b> text<p>A paragraph with <i>style</i>.</p><ul><li>One</li><li>Two</li></ul><table><tr><td>Cell</td></tr></table>Tail</div>',
      'text/html',
    );
    expect(blocksToText(doc.body).split('\n\n')).toEqual(['Loose inline text', 'A paragraph with style.', 'One', 'Two', 'Cell', 'Tail']);
  });

  it('keeps line breaks from <br> and drops scripts and styles', () => {
    const doc = new DOMParser().parseFromString('<p>Line one<br>line two<script>bad()</script><style>p{}</style></p>', 'text/html');
    expect(blocksToText(doc.body)).toBe('Line one\nline two');
  });
});

describe('extractArticle', () => {
  it('extracts title, byline and paragraphs and leaves out page furniture', () => {
    const a = extractArticle(PAGE, 'https://news.example/story');
    const paragraphs = a.text.split('\n\n');
    expect(a.title).toBe('The Title');
    expect(a.siteName).toBe('Example News');
    expect(paragraphs).toContain(para(1));
    expect(paragraphs.some((p) => p.startsWith('Paragraph 2') && p.includes('emphasis, a link and a line\nbreak.'))).toBe(true);
    expect(paragraphs).toContain('A subheading');
    expect(paragraphs).toContain('First point in a list.');
    expect(paragraphs).toContain(para(4));
    expect(paragraphs).toContain(para(5));
    expect(a.text).not.toMatch(/Home|Copyright|window\.evil|pwned/);
  });

  it('never runs scripts or touches the live document', () => {
    const before = document.body.innerHTML;
    extractArticle(PAGE, 'https://news.example/story');
    expect((window as unknown as { evil?: number }).evil).toBeUndefined();
    expect(document.body.innerHTML).toBe(before);
  });

  it('reports pages without an article', () => {
    expect(() => extractArticle('<html><body><nav>Home</nav></body></html>', 'https://x.example/')).toThrow(UrlImportError);
  });
});
