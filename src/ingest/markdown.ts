import { Lexer, type Token, type Tokens } from 'marked';
import { normalizeText, PARAGRAPH_BREAK, segment } from '../segment/segment';
import { STYLE, type BlockStyle, type DocFormat } from '../types';

/** How the import editor's text is interpreted. */
export type TextFormat = 'plain' | 'markdown';

export interface ConvertedDoc {
  /** Normalized plain text (see normalizeText): what is paced, scored and stored. */
  text: string;
  /** Formatting for the text views, or null when there is none. */
  format: DocFormat | null;
}

/*
 * Markdown becomes plain text in two passes. The first walks marked's tokens
 * and writes the text with private-use sentinel characters marking where
 * styles, links and block kinds start and end. That string goes through the
 * ordinary normalizeText, so paragraph splitting and whitespace handling are
 * exactly those of a plain-text import. The second pass strips the sentinels
 * chunk by chunk and turns them into per-word formatting. Sentinels are never
 * whitespace, so they cannot move a word boundary.
 */

/** Open/close pairs for the inline styles, in STYLE bit order: bold, italic, code, strike. */
const INLINE_BASE = 0xe000;
const STYLE_KEYS = ['bold', 'italic', 'code', 'strike'] as const;
type StyleKey = (typeof STYLE_KEYS)[number];
const LINK_CLOSE = 0xe008;
/** Block styles are interned and referenced from plane 15, links from plane 16. */
const BLOCK_BASE = 0xf0000;
const LINK_BASE = 0x100000;
const TABLE_MAX = 0xfffd;
/** Every code point the converter uses as a sentinel; removed from input text first. */
const SENTINELS = /[-]|[\u{F0000}-\u{10FFFF}]/gu;

const open = (k: StyleKey) => String.fromCharCode(INLINE_BASE + 2 * STYLE_KEYS.indexOf(k));
const close = (k: StyleKey) => String.fromCharCode(INLINE_BASE + 2 * STYLE_KEYS.indexOf(k) + 1);

/** Links are kept only when they are safe to open from the reader. */
export function safeHref(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : null;
  } catch {
    return null;
  }
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0', ndash: '\u2013', mdash: '\u2014',
  hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«',
  raquo: '»', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•',
  deg: '°', times: '×', divide: '÷', euro: '€', pound: '£', yen: '¥',
  cent: '¢', sect: '§', para: '¶', shy: '\u00AD', minus: '−', larr: '←',
  rarr: '→', harr: '↔', le: '≤', ge: '≥', ne: '≠', asymp: '≈',
  eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', ouml: 'ö', uuml: 'ü',
  auml: 'ä', szlig: 'ß', ccedil: 'ç', ntilde: 'ñ', iexcl: '¡', iquest: '¿',
};

/** Decode the HTML character references marked leaves in text tokens. Unknown names are kept as written. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, body: string) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '�';
    }
    return NAMED[body] ?? m;
  });
}

/** Inline HTML tags marked passes through, and the style each one stands for. */
const HTML_STYLE: Record<string, StyleKey> = {
  b: 'bold', strong: 'bold', i: 'italic', em: 'italic', cite: 'italic', dfn: 'italic',
  code: 'code', kbd: 'code', samp: 'code', tt: 'code', s: 'strike', del: 'strike', strike: 'strike',
};

interface Ctx {
  /** Style for ordinary paragraphs here (null: plain prose). */
  para: BlockStyle | null;
  /** Depth the next list's items get. */
  listDepth: number;
  quote: boolean;
}

type HtmlOpen = ({ kind: 'style'; key: StyleKey } | { kind: 'link' })[];

class Emitter {
  out = '';
  readonly blocks: BlockStyle[] = [];
  readonly links: string[] = [];
  private blockIds = new Map<string, number>();
  private linkIds = new Map<string, number>();
  /** Written after every line break inside the current block, so a line that becomes its own paragraph keeps the block's style. */
  private lineMark = '';

  private blockChar(style: BlockStyle | null): string {
    if (!style) return '';
    const key = JSON.stringify(style);
    let id = this.blockIds.get(key);
    if (id === undefined) {
      if (this.blocks.length >= TABLE_MAX) return '';
      id = this.blocks.length;
      this.blocks.push(style);
      this.blockIds.set(key, id);
    }
    return String.fromCodePoint(BLOCK_BASE + id);
  }

  private linkChar(href: string): string | null {
    let id = this.linkIds.get(href);
    if (id === undefined) {
      if (this.links.length >= TABLE_MAX) return null;
      id = this.links.length;
      this.links.push(href);
      this.linkIds.set(href, id);
    }
    return String.fromCodePoint(LINK_BASE + id);
  }

  start(style: BlockStyle | null, lines: BlockStyle | null = style): void {
    this.out += PARAGRAPH_BREAK + this.blockChar(style);
    this.lineMark = this.blockChar(lines);
  }

  newline(): void {
    this.out += '\n' + this.lineMark;
  }

  text(s: string): void {
    const clean = s.replace(SENTINELS, '');
    this.out += this.lineMark ? clean.replace(/\n/g, '\n' + this.lineMark) : clean;
  }

  // Block level

  blockTokens(tokens: readonly Token[], ctx: Ctx): void {
    for (const t of tokens) this.block(t, ctx);
  }

  private quoteFlag(ctx: Ctx): { quote?: true } {
    return ctx.quote ? { quote: true } : {};
  }

  private block(t: Token, ctx: Ctx): void {
    switch (t.type) {
      case 'space':
      case 'hr':
      case 'def':
        return;
      case 'heading': {
        const h = t as Tokens.Heading;
        const kind = `h${Math.min(6, Math.max(1, h.depth))}` as BlockStyle['kind'];
        this.start({ kind, ...this.quoteFlag(ctx) });
        this.inline(h.tokens);
        return;
      }
      case 'paragraph':
      case 'text': {
        this.start(ctx.para);
        const tokens = (t as Tokens.Paragraph).tokens;
        if (tokens?.length) this.inline(tokens);
        else this.text(decodeEntities((t as Tokens.Text).text));
        return;
      }
      case 'code': {
        const style: BlockStyle = { kind: 'code', ...this.quoteFlag(ctx) };
        for (const line of (t as Tokens.Code).text.split('\n')) {
          if (!line.trim()) continue;
          this.start(style);
          this.text(line);
        }
        return;
      }
      case 'blockquote':
        this.blockTokens((t as Tokens.Blockquote).tokens, { ...ctx, quote: true, para: { kind: 'quote' } });
        return;
      case 'list': {
        const list = t as Tokens.List;
        const first = typeof list.start === 'number' ? list.start : 1;
        list.items.forEach((item, k) => this.listItem(item, list.ordered ? first + k : null, ctx));
        return;
      }
      case 'table': {
        const table = t as Tokens.Table;
        this.row(table.header, { kind: 'th', ...this.quoteFlag(ctx) });
        for (const r of table.rows) this.row(r, { kind: 'tr', ...this.quoteFlag(ctx) });
        return;
      }
      case 'html':
        this.htmlBlock((t as Tokens.HTML).text, ctx);
        return;
      default: {
        const generic = t as { tokens?: Token[]; text?: string };
        if (generic.tokens?.length) this.blockTokens(generic.tokens, ctx);
        else if (generic.text) {
          this.start(ctx.para);
          this.text(decodeEntities(generic.text));
        }
      }
    }
  }

  private listItem(item: Tokens.ListItem, number: number | null, ctx: Ctx): void {
    const depth = ctx.listDepth;
    const q = this.quoteFlag(ctx);
    const first: BlockStyle = { kind: 'li', depth, ...q, ...(number != null ? { ordered: true } : {}) };
    const cont: BlockStyle = { kind: 'li', depth, cont: true, ...q };
    const inner: Ctx = { para: cont, listDepth: depth + 1, quote: ctx.quote };
    let started = false;
    for (const child of item.tokens) {
      if (child.type === 'checkbox') continue;
      if ((child.type === 'text' || child.type === 'paragraph') && !started) {
        started = true;
        this.start(first, cont);
        if (number != null) this.text(`${number}. `);
        const tokens = (child as Tokens.Text).tokens;
        if (tokens?.length) this.inline(tokens);
        else this.text(decodeEntities((child as Tokens.Text).text));
      } else {
        this.block(child, inner);
      }
    }
  }

  private row(cells: Tokens.TableCell[], style: BlockStyle): void {
    const filled = cells.filter((c) => c.text.trim());
    if (!filled.length) return;
    this.start(style);
    filled.forEach((cell, k) => {
      this.inline(cell.tokens);
      if (k < filled.length - 1) this.text(/[.,;:!?]$/.test(cell.text.trim()) ? ' ' : '; ');
    });
  }

  private htmlBlock(html: string, ctx: Ctx): void {
    const text = decodeEntities(
      html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre|section|article|table|ul|ol|dt|dd)\s*>/gi, '\n\n')
        .replace(/<[^>]*>/g, ''),
    );
    for (const para of text.split(/\n\s*\n/)) {
      if (!para.trim()) continue;
      this.start(ctx.para);
      this.text(para);
    }
  }

  // Inline level

  /** Inline tokens of one block. Styles opened by inline HTML are closed at its end. */
  inline(tokens: readonly Token[]): void {
    const htmlOpen: HtmlOpen = [];
    this.inlineTokens(tokens, htmlOpen);
    for (let k = htmlOpen.length - 1; k >= 0; k--) {
      const o = htmlOpen[k];
      this.out += o.kind === 'link' ? String.fromCharCode(LINK_CLOSE) : close(o.key);
    }
  }

  private inlineTokens(tokens: readonly Token[], htmlOpen: HtmlOpen): void {
    for (const t of tokens) this.inlineToken(t, htmlOpen);
  }

  private wrap(key: StyleKey, tokens: readonly Token[] | undefined, htmlOpen: HtmlOpen): void {
    this.out += open(key);
    if (tokens) this.inlineTokens(tokens, htmlOpen);
    this.out += close(key);
  }

  private inlineToken(t: Token, htmlOpen: HtmlOpen): void {
    switch (t.type) {
      case 'text': {
        const tokens = (t as Tokens.Text).tokens;
        if (tokens?.length) this.inlineTokens(tokens, htmlOpen);
        else this.text(decodeEntities((t as Tokens.Text).text));
        return;
      }
      case 'escape':
        this.text((t as Tokens.Escape).text);
        return;
      case 'strong':
        this.wrap('bold', (t as Tokens.Strong).tokens, htmlOpen);
        return;
      case 'em':
        this.wrap('italic', (t as Tokens.Em).tokens, htmlOpen);
        return;
      case 'del':
        this.wrap('strike', (t as Tokens.Del).tokens, htmlOpen);
        return;
      case 'codespan':
        this.out += open('code');
        this.text((t as Tokens.Codespan).text.replace(/\n/g, ' '));
        this.out += close('code');
        return;
      case 'link': {
        const link = t as Tokens.Link;
        const href = safeHref(link.href);
        const mark = href ? this.linkChar(href) : null;
        if (mark) this.out += mark;
        this.inlineTokens(link.tokens, htmlOpen);
        if (mark) this.out += String.fromCharCode(LINK_CLOSE);
        return;
      }
      case 'image':
      case 'checkbox':
        return;
      case 'br':
        this.newline();
        return;
      case 'html':
        this.inlineHtml((t as Tokens.HTML).text, htmlOpen);
        return;
      default: {
        const generic = t as { tokens?: Token[]; text?: string };
        if (generic.tokens?.length) this.inlineTokens(generic.tokens, htmlOpen);
        else if (generic.text) this.text(decodeEntities(generic.text));
      }
    }
  }

  private inlineHtml(tag: string, htmlOpen: HtmlOpen): void {
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>$/.exec(tag.trim());
    if (!m) return;
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    if (name === 'br') {
      this.newline();
      return;
    }
    if (name === 'a') {
      if (closing) {
        const k = htmlOpen.map((o) => o.kind).lastIndexOf('link');
        if (k >= 0) {
          htmlOpen.splice(k, 1);
          this.out += String.fromCharCode(LINK_CLOSE);
        }
        return;
      }
      const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[3]);
      const safe = safeHref(href ? decodeEntities(href[1] ?? href[2] ?? href[3]) : null);
      const mark = safe ? this.linkChar(safe) : null;
      if (mark) {
        this.out += mark;
        htmlOpen.push({ kind: 'link' });
      }
      return;
    }
    const key = HTML_STYLE[name];
    if (!key) return;
    if (closing) {
      const k = htmlOpen.findLastIndex((o) => o.kind === 'style' && o.key === key);
      if (k >= 0) {
        htmlOpen.splice(k, 1);
        this.out += close(key);
      }
    } else if (!/\/$/.test(m[3])) {
      this.out += open(key);
      htmlOpen.push({ kind: 'style', key });
    }
  }
}

/** Turn the sentinel-marked string into plain normalized text and per-word formatting. */
function finish(e: Emitter): ConvertedDoc {
  const normalized = normalizeText(e.out);
  const paragraphs: string[] = [];
  const chunkBits: number[] = [];
  const chunkLink: number[] = [];
  const paraBlock: number[] = [];
  const depth = [0, 0, 0, 0];
  const linkStack: number[] = [];
  const bitsNow = () => (depth[0] ? STYLE.bold : 0) | (depth[1] ? STYLE.italic : 0) | (depth[2] ? STYLE.code : 0) | (depth[3] ? STYLE.strike : 0);

  for (const para of normalized ? normalized.split(PARAGRAPH_BREAK) : []) {
    let block = -1;
    const kept: string[] = [];
    for (const chunk of para.split(' ')) {
      let clean = '';
      let bits = 0;
      let link = -1;
      for (const ch of chunk) {
        const cp = ch.codePointAt(0)!;
        if (cp >= INLINE_BASE && cp < LINK_CLOSE) {
          const k = (cp - INLINE_BASE) >> 1;
          depth[k] = cp & 1 ? Math.max(0, depth[k] - 1) : depth[k] + 1;
        } else if (cp === LINK_CLOSE) linkStack.pop();
        else if (cp >= LINK_BASE) linkStack.push(cp - LINK_BASE);
        else if (cp >= BLOCK_BASE) {
          if (block < 0) block = cp - BLOCK_BASE;
        } else {
          clean += ch;
          bits |= bitsNow();
          if (link < 0 && linkStack.length) link = linkStack[linkStack.length - 1];
        }
      }
      // Removing a sentinel can bring a base letter and a combining mark together.
      clean = clean.normalize('NFKC');
      if (!clean) continue;
      kept.push(clean);
      chunkBits.push(bits);
      chunkLink.push(link);
    }
    if (kept.length) {
      paragraphs.push(kept.join(' '));
      paraBlock.push(block);
    }
  }

  const text = paragraphs.join(PARAGRAPH_BREAK);
  const words = segment(text);
  const runs: DocFormat['runs'] = [];
  const links: DocFormat['links'] = [];
  let c = -1;
  for (const w of words) {
    if (!w.glued) c++;
    const bits = chunkBits[c];
    const lastRun = runs[runs.length - 1];
    if (bits) {
      if (lastRun && lastRun[1] === w.index && lastRun[2] === bits) lastRun[1]++;
      else runs.push([w.index, w.index + 1, bits]);
    }
    const id = chunkLink[c];
    if (id >= 0) {
      const href = e.links[id];
      const lastLink = links[links.length - 1];
      if (lastLink && lastLink[1] === w.index && lastLink[2] === href) lastLink[1]++;
      else links.push([w.index, w.index + 1, href]);
    }
  }
  const blocks: DocFormat['blocks'] = [];
  paraBlock.forEach((b, p) => {
    if (b >= 0) blocks.push([p, e.blocks[b]]);
  });
  const format = runs.length || links.length || blocks.length ? { v: 1 as const, runs, links, blocks } : null;
  return { text, format };
}

/** Markdown (CommonMark with GitHub tables, strikethrough and autolinks) to plain text with formatting. */
export function markdownToDoc(src: string): ConvertedDoc {
  const e = new Emitter();
  const tokens = Lexer.lex(src.replace(SENTINELS, ''), { gfm: true });
  e.blockTokens(tokens, { para: null, listDepth: 0, quote: false });
  return finish(e);
}

/** Convert editor text in the given format. */
export function convertText(src: string, format: TextFormat): ConvertedDoc {
  return format === 'markdown' ? markdownToDoc(src) : { text: normalizeText(src), format: null };
}

const STRONG_SIGNS = [
  /\[[^\]\n]+\]\((?:https?:|mailto:|\/|#|\.)[^)\s]*(?:\s+"[^"\n]*")?\)/, // [text](url)
  /(?:^|[\s(])(\*\*|__)(?=\S)[^\n]*?\S\1(?=$|[\s.,;:!?)])/m, // **bold** or __bold__
  /^#{1,6}[ \t]+\S/m, // # heading
  /^ {0,3}(```|~~~)/m, // fenced code
  /^ {0,3}\|?[ \t]*:?-{3,}:?[ \t]*\|/m, // table separator row
];
const WEAK_SIGNS = [
  /^ {0,3}[-*+][ \t]+\S/m, // bullet list
  /^ {0,3}>[ \t]?\S/m, // quote
  /`[^`\n]+`/, // inline code
  /(?:^|[\s(])\*(?=[^\s*])[^*\n]*[^\s*]\*(?=$|[\s.,;:!?)])/m, // *italic*
  /^\[[^\]\n]+\]:[ \t]*\S/m, // link definition
];

/** Guess whether pasted or loaded text was written as Markdown. Plain text is the safe default. */
export function looksLikeMarkdown(src: string): boolean {
  const sample = src.length > 200_000 ? src.slice(0, 200_000) : src;
  if (STRONG_SIGNS.some((r) => r.test(sample))) return true;
  return WEAK_SIGNS.filter((r) => r.test(sample)).length >= 2;
}
