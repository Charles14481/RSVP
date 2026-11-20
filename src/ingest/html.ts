import { safeHref } from './markdown';

/*
 * HTML to Markdown, for rich text pasted from web pages, Word or Google Docs,
 * for .html files and for fetched articles. Markdown is the one editable form
 * the import preview works with, so everything that has formatting arrives as
 * Markdown and is converted from there.
 *
 * The input is an inert document from DOMParser, never attached to the page,
 * and is read through textContent, tag names and a few attributes only.
 */

const SKIP = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'IFRAME', 'OBJECT', 'EMBED', 'BUTTON', 'SELECT',
  'TEXTAREA', 'INPUT', 'CANVAS', 'VIDEO', 'AUDIO', 'PICTURE', 'IMG', 'HEAD', 'TITLE', 'META', 'LINK', 'NAV',
]);
const BLOCK = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'FORM', 'FIELDSET', 'DETAILS', 'SUMMARY',
  'FIGURE', 'FIGCAPTION', 'ADDRESS', 'DL', 'DT', 'DD', 'CENTER', 'BODY', 'HTML', 'CAPTION',
]);
const HEADINGS: Record<string, number> = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };

interface Marks {
  bold: boolean;
  italic: boolean;
  code: boolean;
  strike: boolean;
  link: boolean;
}

const NONE: Marks = { bold: false, italic: false, code: false, strike: false, link: false };

/** Escape characters Markdown would read as syntax inside running text. */
function escapeInline(s: string): string {
  return s.replace(/[\\`*_[\]<>~|]/g, '\\$&').replace(/&(?=#?[a-zA-Z0-9]+;)/g, '\\&');
}

/** Escape what would start a block at the beginning of a line. */
function escapeLineStart(line: string): string {
  return line
    .replace(/^(\s*)(#{1,6})(?=\s|$)/, '$1\\$2')
    .replace(/^(\s*)([-+])(?=\s)/, '$1\\$2')
    .replace(/^(\s*)(\d+)([.)])(?=\s)/, '$1$2\\$3')
    .replace(/^(\s*)(=+|-{3,})\s*$/, '$1\\$2');
}

/** Bold and italic as Google Docs and Word express them: inline styles on spans. */
function styleMarks(el: Element, marks: Marks): Marks {
  const style = el.getAttribute('style');
  if (!style) return marks;
  let next = marks;
  const weight = /font-weight\s*:\s*([a-z0-9]+)/i.exec(style)?.[1].toLowerCase();
  if (weight) {
    const bold = weight === 'bold' || weight === 'bolder' || Number(weight) >= 600;
    if (bold !== marks.bold) next = { ...next, bold };
  }
  const fontStyle = /font-style\s*:\s*([a-z]+)/i.exec(style)?.[1].toLowerCase();
  if (fontStyle) {
    const italic = fontStyle === 'italic' || fontStyle === 'oblique';
    if (italic !== marks.italic) next = { ...next, italic };
  }
  if (/text-decoration[^;]*line-through/i.test(style) && !marks.strike) next = { ...next, strike: true };
  if (/font-family\s*:[^;]*(mono|courier|consolas)/i.test(style) && !marks.code) next = { ...next, code: true };
  return next;
}

function tagMarks(el: Element, marks: Marks): Marks {
  switch (el.tagName) {
    case 'B':
    case 'STRONG':
      // Google Docs wraps a whole paste in <b style="font-weight:normal">.
      return styleMarks(el, { ...marks, bold: true });
    case 'I':
    case 'EM':
    case 'CITE':
    case 'DFN':
      return styleMarks(el, { ...marks, italic: true });
    case 'CODE':
    case 'KBD':
    case 'SAMP':
    case 'TT':
      return { ...marks, code: true };
    case 'S':
    case 'DEL':
    case 'STRIKE':
      return { ...marks, strike: true };
    default:
      return styleMarks(el, marks);
  }
}

/**
 * Inline content as Markdown. Delimiters are opened and closed per text run,
 * with whitespace moved outside them so they stay valid ("**a **b" would not
 * be bold), and adjacent runs with the same marks are merged.
 */
class InlineWriter {
  private runs: { text: string; marks: Marks; href: string | null }[] = [];

  push(text: string, marks: Marks, href: string | null): void {
    if (!text) return;
    const last = this.runs[this.runs.length - 1];
    if (last && last.href === href && sameMarks(last.marks, marks)) last.text += text;
    else this.runs.push({ text, marks, href });
  }

  newline(): void {
    this.push('\n', NONE, null);
  }

  get empty(): boolean {
    return !this.runs.some((r) => r.text.trim());
  }

  /** The paragraph's Markdown; whitespace collapsed as a browser would. */
  take(): string {
    // Merge links first: a link is one [..](..) around all its runs.
    let out = '';
    let i = 0;
    const runs = this.runs;
    this.runs = [];
    while (i < runs.length) {
      const href = runs[i].href;
      let j = i;
      let inner = '';
      while (j < runs.length && runs[j].href === href) {
        inner += styled(runs[j].text, runs[j].marks);
        j++;
      }
      out += href ? linked(inner, href) : inner;
      i = j;
    }
    return out
      .split('\n')
      .map((l) => escapeLineStart(l.replace(/[ \t\r\f]+/g, ' ').trim()))
      .join('\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }
}

function sameMarks(a: Marks, b: Marks): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.code === b.code && a.strike === b.strike;
}

function styled(raw: string, m: Marks): string {
  const collapsed = raw.replace(/[ \t\r\f]+/g, ' ');
  if (!m.bold && !m.italic && !m.code && !m.strike) return escapeInline(collapsed);
  // Line breaks end the delimiters: emphasis cannot span a hard break cleanly.
  return collapsed
    .split('\n')
    .map((part) => {
      const lead = /^\s*/.exec(part)![0];
      const trail = /\s*$/.exec(part)![0];
      const core = part.slice(lead.length, part.length - trail.length);
      if (!core) return part;
      let s: string;
      if (m.code) {
        const ticks = /`+/g.test(core) ? '``' : '`';
        s = ticks + (core.startsWith('`') || core.endsWith('`') ? ` ${core} ` : core) + ticks;
      } else s = escapeInline(core);
      if (m.strike) s = `~~${s}~~`;
      if (m.italic) s = `*${s}*`;
      if (m.bold) s = `**${s}**`;
      return lead + s + trail;
    })
    .join('\n');
}

function linked(inner: string, href: string): string {
  const lead = /^\s*/.exec(inner)![0];
  const trail = /\s*$/.exec(inner)![0];
  const core = inner.slice(lead.length, inner.length - trail.length);
  if (!core) return inner;
  return `${lead}[${core}](<${href.replace(/[<>\s]/g, encodeURIComponent)}>)${trail}`;
}

interface BlockCtx {
  /** Inside <pre>: keep whitespace. */
  pre: boolean;
}

/** Convert a DOM subtree to Markdown blocks. */
class BlockWriter {
  blocks: string[] = [];
  private inline = new InlineWriter();

  flush(): void {
    if (!this.inline.empty) this.blocks.push(this.inline.take());
    else this.inline.take();
  }

  walk(node: Node, marks: Marks, href: string | null, ctx: BlockCtx): void {
    if (node.nodeType === 3) {
      const text = node.textContent ?? '';
      this.inline.push(ctx.pre ? text : text.replace(/\s+/g, ' '), marks, href);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag) || el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) return;

    if (tag === 'BR') {
      this.inline.newline();
      return;
    }
    if (tag === 'HR') {
      this.flush();
      return;
    }
    const level = HEADINGS[tag];
    if (level) {
      this.flush();
      const inner = sub(el, NONE, null, ctx);
      const text = inner.join(' ').replace(/\n+/g, ' ').trim();
      if (text) this.blocks.push(`${'#'.repeat(level)} ${text}`);
      return;
    }
    if (tag === 'UL' || tag === 'OL') {
      this.flush();
      const start = Number(el.getAttribute('start')) || 1;
      let n = 0;
      for (const child of Array.from(el.children)) {
        if (child.tagName.toUpperCase() !== 'LI') continue;
        const marker = tag === 'OL' ? `${start + n}. ` : '- ';
        n++;
        const inner = sub(child, marks, href, ctx);
        if (!inner.length) continue;
        const pad = ' '.repeat(marker.length);
        const body = inner.join('\n\n').split('\n');
        this.blocks.push(body.map((l, k) => (k === 0 ? marker + l : l ? pad + l : l)).join('\n'));
      }
      // Consecutive items are one tight list.
      this.mergeList();
      return;
    }
    if (tag === 'BLOCKQUOTE') {
      this.flush();
      const inner = sub(el, marks, href, ctx);
      if (inner.length) this.blocks.push(inner.join('\n\n').split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
      return;
    }
    if (tag === 'PRE') {
      this.flush();
      const code = (el.textContent ?? '').replace(/\n+$/, '');
      if (code.trim()) {
        const fence = /```/.test(code) ? '~~~~' : '```';
        this.blocks.push(`${fence}\n${code}\n${fence}`);
      }
      return;
    }
    if (tag === 'TABLE') {
      this.flush();
      const table = tableMarkdown(el, ctx);
      if (table) this.blocks.push(table);
      return;
    }

    const block = BLOCK.has(tag) || tag === 'LI' || tag === 'TR';
    if (block) this.flush();
    let m = tagMarks(el, marks);
    let h = href;
    if (tag === 'A') {
      const safe = safeHref(el.getAttribute('href'));
      if (safe) {
        h = safe;
        m = { ...m, link: true };
      }
    }
    for (const child of Array.from(el.childNodes)) this.walk(child, m, h, ctx);
    if (block) this.flush();
  }

  /** Join the list items just written into one block so they form a single tight list. */
  private mergeList(): void {
    // Items were pushed one block each; consecutive item blocks start with a marker.
    const isItem = (b: string) => /^(- |\d+\. )/.test(b);
    let k = this.blocks.length;
    while (k > 0 && isItem(this.blocks[k - 1])) k--;
    if (this.blocks.length - k > 1) {
      const items = this.blocks.splice(k);
      this.blocks.push(items.join('\n'));
    }
  }
}

function sub(el: Element, marks: Marks, href: string | null, ctx: BlockCtx): string[] {
  const w = new BlockWriter();
  for (const child of Array.from(el.childNodes)) w.walk(child, marks, href, ctx);
  w.flush();
  return w.blocks;
}

function tableMarkdown(table: Element, ctx: BlockCtx): string | null {
  const rows: string[][] = [];
  for (const tr of Array.from(table.querySelectorAll('tr'))) {
    if (tr.closest('table') !== table) continue;
    const cells = Array.from(tr.children)
      .filter((c) => /^(TD|TH)$/i.test(c.tagName))
      .map((c) => sub(c, NONE, null, ctx).join(' ').replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim());
    if (cells.some(Boolean)) rows.push(cells);
  }
  if (!rows.length) return null;
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, k) => r[k] ?? '').join(' | ')} |`;
  return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
}

/** Markdown for the content of an element (usually a parsed document's body). */
export function htmlToMarkdown(root: Element): string {
  return sub(root, NONE, null, { pre: false }).join('\n\n');
}

/** Parse an HTML string inertly and convert its body. */
export function htmlStringToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body ? htmlToMarkdown(doc.body) : '';
}

/**
 * Whether pasted HTML carries formatting worth keeping. Plain HTML (a copy
 * from a text box, a terminal, most code editors) is better pasted as its
 * plain-text twin.
 */
export function htmlHasFormatting(html: string): boolean {
  if (/<(b|strong|i|em|h[1-6]|li|blockquote|pre|code|table|del|s)\b/i.test(html)) return true;
  if (/<a\s[^>]*href\s*=\s*["']?(https?:|mailto:)/i.test(html)) return true;
  return /font-weight\s*:\s*(bold|[6-9]00)|font-style\s*:\s*italic/i.test(html);
}
