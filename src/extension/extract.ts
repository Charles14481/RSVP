import { Readability } from '@mozilla/readability';
import { CONTAINERS, LEAF_BLOCKS, SKIP } from '../ingest/url';
import { chunksOf, normalizeChunk, PARAGRAPH_BREAK, segment } from '../segment/segment';
import { STYLE, type DocFormat, type Word } from '../types';

/**
 * Reads the text of a live web page into the reader's normalized text and
 * keeps, for every word, where it sits in the page, so the word on screen can
 * be highlighted in place. Nothing in the page is modified.
 *
 * Readability decides which text is the article (run on a clone); the live
 * DOM decides paragraph structure, visibility and positions.
 */

export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractError';
  }
}

export type ExtractSource = 'selection' | 'article' | 'page';

export interface ExtractOptions {
  /** Read only what these ranges cover (the user's selection). */
  ranges?: readonly Range[];
  /** An element whose text is never read: the reader's own overlay. */
  exclude?: Element | null;
  /**
   * Use computed styles for visibility, blocks and preformatted text. Turn off
   * where there is no layout (jsdom); tag names are used instead.
   */
  layout?: boolean;
  /** An article shorter than this falls back to the page's visible text. */
  minArticleWords?: number;
}

export interface PageText {
  /** Normalized text (see normalizeText): what the session, the model and the cache see. */
  text: string;
  title: string;
  words: Word[];
  /** Bold, italic and code runs, for the flashed word. */
  format: DocFormat | null;
  source: ExtractSource;
  /** A range from the start of word i to the end of word end - 1, or null if the page has changed under it. */
  span(i: number, end: number): Range | null;
  /**
   * The word at a point in the page. Exact: only a point inside (or at the
   * edge of) a word, else -1. Otherwise the first word at or after the point,
   * or the last word if the point is past the end.
   */
  wordAt(node: Node, offset: number, exact?: boolean): number;
}

const BOLD = new Set(['B', 'STRONG', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TH']);
const ITALIC = new Set(['I', 'EM', 'CITE', 'DFN', 'VAR']);
const CODE = new Set(['CODE', 'KBD', 'SAMP', 'TT']);
const STRIKE = new Set(['S', 'DEL', 'STRIKE']);

function tagBits(tag: string): number {
  if (BOLD.has(tag)) return STYLE.bold;
  if (ITALIC.has(tag)) return STYLE.italic;
  if (CODE.has(tag)) return STYLE.code;
  if (STRIKE.has(tag)) return STYLE.strike;
  return 0;
}

const PRE_SPACE = /^(pre|pre-wrap|pre-line|break-spaces)$/;

/** Which parts [from, to) of a text node to read; empty to skip it. */
type TextFilter = (t: Text) => readonly (readonly [number, number])[];

interface Pending {
  raw: string;
  sN: number;
  sO: number;
  eN: number;
  eO: number;
  bits: number;
}

/** Turns a walk over text nodes into chunks (whitespace-delimited words) with page positions. */
class Collector {
  readonly nodes: Text[] = [];
  private readonly nodeIds = new Map<Text, number>();
  readonly texts: string[] = [];
  readonly sN: number[] = [];
  readonly sO: number[] = [];
  readonly eN: number[] = [];
  readonly eO: number[] = [];
  readonly bits: number[] = [];
  /** Chunk count at the end of each paragraph. */
  readonly paraEnds: number[] = [];
  private pending: Pending | null = null;
  private paraStart = 0;

  private nodeId(t: Text): number {
    let id = this.nodeIds.get(t);
    if (id === undefined) {
      id = this.nodes.push(t) - 1;
      this.nodeIds.set(t, id);
    }
    return id;
  }

  closeChunk(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    // Normalization can drop a chunk (only invisible characters) or split it; pieces share its position.
    for (const piece of normalizeChunk(p.raw)) {
      this.texts.push(piece);
      this.sN.push(p.sN);
      this.sO.push(p.sO);
      this.eN.push(p.eN);
      this.eO.push(p.eO);
      this.bits.push(p.bits);
    }
  }

  breakParagraph(): void {
    this.closeChunk();
    if (this.texts.length > this.paraStart) {
      this.paraEnds.push(this.texts.length);
      this.paraStart = this.texts.length;
    }
  }

  /** Read t.data[from, to); in preformatted text a newline ends the paragraph. */
  text(t: Text, from: number, to: number, bits: number, pre: boolean): void {
    if (!pre) {
      this.scan(t, from, to, bits);
      return;
    }
    let a = from;
    for (;;) {
      const nl = t.data.indexOf('\n', a);
      const end = nl === -1 || nl >= to ? to : nl;
      this.scan(t, a, end, bits);
      if (end >= to) return;
      this.breakParagraph();
      a = end + 1;
    }
  }

  private scan(t: Text, from: number, to: number, bits: number): void {
    if (from >= to) return;
    const data = t.data;
    const re = /\S+/g;
    re.lastIndex = from;
    let pos = from;
    for (let m = re.exec(data); m && m.index < to; m = re.exec(data)) {
      const a = m.index;
      const b = Math.min(to, a + m[0].length);
      if (a > pos) this.closeChunk();
      const id = this.nodeId(t);
      const p = this.pending;
      if (p) {
        p.raw += data.slice(a, b);
        p.eN = id;
        p.eO = b;
        p.bits |= bits;
      } else {
        this.pending = { raw: data.slice(a, b), sN: id, sO: a, eN: id, eO: b, bits };
      }
      pos = b;
      if (b >= to) break;
    }
    // Whitespace after the last word ends it; a word running to the end may continue in the next node.
    if (pos < to) this.closeChunk();
  }
}

interface WalkConfig {
  layout: boolean;
  exclude: Element | null;
  filter: TextFilter;
  /** Only descend into these elements (ancestors of the article); null for all. */
  within: Set<Element> | null;
}

function walk(root: Element, cfg: WalkConfig, out: Collector): void {
  const view = root.ownerDocument.defaultView;

  const element = (el: Element, bits: number, pre: boolean, visible: boolean): void => {
    if (el === cfg.exclude) return;
    if (cfg.within && !cfg.within.has(el)) return;
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag)) return;
    if (tag === 'BR') {
      out.breakParagraph();
      return;
    }
    let block: boolean;
    let childPre = pre;
    let childVisible = visible;
    if (cfg.layout && view) {
      const cs = view.getComputedStyle(el);
      const display = cs.display;
      if (display === 'none' || cs.getPropertyValue('content-visibility') === 'hidden') return;
      // "Visually hidden" text for screen readers: clipped to a pixel.
      if ((cs.position === 'absolute' || cs.position === 'fixed') && parseFloat(cs.width) <= 1 && parseFloat(cs.height) <= 1) return;
      block = !(display.startsWith('inline') || display.startsWith('ruby') || display === 'contents');
      const collapse = cs.getPropertyValue('white-space-collapse');
      childPre = collapse ? collapse !== 'collapse' && collapse !== 'discard' : PRE_SPACE.test(cs.whiteSpace);
      childVisible = cs.visibility === 'visible';
    } else {
      if (el.hasAttribute('hidden')) return;
      block = LEAF_BLOCKS.has(tag) || CONTAINERS.has(tag);
      childPre = pre || tag === 'PRE';
    }
    if (block) out.breakParagraph();
    children(el, bits | tagBits(tag), childPre, childVisible);
    if (block) out.breakParagraph();
  };

  const children = (el: Element, bits: number, pre: boolean, visible: boolean): void => {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === Node.TEXT_NODE) {
        const t = n as Text;
        const parts = visible ? cfg.filter(t) : [];
        if (!parts.length) {
          // Skipped text separates words rather than gluing its neighbours together.
          if (t.data.length) out.closeChunk();
          continue;
        }
        let last = -1;
        for (const [from, to] of parts) {
          if (last !== -1 && from > last) out.closeChunk();
          out.text(t, from, to, bits, pre);
          last = to;
        }
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        element(n as Element, bits, pre, visible);
      }
    }
  };

  // Start from the root with what it inherits from its ancestors.
  const parent = root.parentElement;
  let bits = 0;
  let pre = false;
  let visible = true;
  for (let a = parent; a; a = a.parentElement) {
    const tag = a.tagName.toUpperCase();
    bits |= tagBits(tag);
    if (tag === 'PRE') pre = true;
  }
  if (cfg.layout && view && parent) {
    const cs = view.getComputedStyle(parent);
    pre = PRE_SPACE.test(cs.whiteSpace);
    visible = cs.visibility === 'visible';
  }
  element(root, bits, pre, visible);
  out.breakParagraph();
}

const ALL: TextFilter = (t) => (t.data.length ? [[0, t.data.length]] : []);

/** Clip text nodes to a set of ranges. */
function selectionFilter(ranges: readonly Range[]): TextFilter {
  return (t) => {
    const parts: [number, number][] = [];
    for (const r of ranges) {
      if (!r.intersectsNode(t)) continue;
      const from = r.startContainer === t ? r.startOffset : 0;
      const to = r.endContainer === t ? r.endOffset : t.data.length;
      if (to > from) parts.push([from, to]);
    }
    return parts.sort((a, b) => a[0] - b[0]);
  };
}

/** The live elements whose clones Readability kept in the article, or null if it found none. */
function articleElements(doc: Document): { kept: Set<Element>; title: string } | null {
  const live = doc.body ? [doc.body, ...Array.from(doc.body.querySelectorAll('*'))] : [];
  if (!live.length) return null;
  const clone = doc.cloneNode(true) as Document;
  const copies = clone.body ? [clone.body, ...Array.from(clone.body.querySelectorAll('*'))] : [];
  if (copies.length !== live.length) return null;
  // Attributes survive Readability's retries, which re-parse the page from its HTML.
  for (let i = 0; i < copies.length; i++) copies[i].setAttribute('data-rsvp-i', String(i));
  let article: Element | null = null;
  let title = '';
  try {
    const parsed = new Readability(clone, { charThreshold: 300, serializer: (el: Node) => el }).parse();
    article = (parsed?.content as Element | undefined) ?? null;
    title = parsed?.title ?? '';
  } catch {
    return null;
  }
  if (!article) return null;
  const kept = new Set<Element>();
  for (const el of [article, ...Array.from(article.querySelectorAll('[data-rsvp-i]'))]) {
    const i = Number(el.getAttribute('data-rsvp-i'));
    if (Number.isInteger(i) && live[i]) kept.add(live[i]);
  }
  return kept.size ? { kept, title } : null;
}

function withAncestors(elements: Iterable<Element>): Set<Element> {
  const out = new Set<Element>();
  for (const el of elements) {
    for (let a: Element | null = el; a && !out.has(a); a = a.parentElement) out.add(a);
  }
  return out;
}

function commonRoot(doc: Document, ranges: readonly Range[]): Element {
  let start = ranges[0];
  let end = ranges[0];
  for (const r of ranges) {
    if (r.compareBoundaryPoints(Range.START_TO_START, start) < 0) start = r;
    if (r.compareBoundaryPoints(Range.END_TO_END, end) > 0) end = r;
  }
  const all = doc.createRange();
  all.setStart(start.startContainer, start.startOffset);
  all.setEnd(end.endContainer, end.endOffset);
  const c = all.commonAncestorContainer;
  return (c.nodeType === Node.ELEMENT_NODE ? (c as Element) : c.parentElement) ?? doc.body ?? doc.documentElement;
}

function pageRoot(doc: Document): Element {
  for (const sel of ['article', 'main', '[role="main"]']) {
    const el = doc.querySelector(sel);
    if (el && (el.textContent ?? '').trim().split(/\s+/).length >= 50) return el;
  }
  return doc.body ?? doc.documentElement;
}

function cleanTitle(t: string): string {
  return t.replace(/\s+/g, ' ').trim();
}

/** Read the page: the selection if given, else the article Readability finds, else the visible text. */
export function extractPage(doc: Document, options: ExtractOptions = {}): PageText {
  const layout = options.layout ?? true;
  const exclude = options.exclude ?? null;
  const ranges = (options.ranges ?? []).filter((r) => !r.collapsed);
  const docTitle = cleanTitle(doc.title) || doc.location?.hostname || 'This page';

  if (ranges.length) {
    const out = new Collector();
    walk(commonRoot(doc, ranges), { layout, exclude, filter: selectionFilter(ranges), within: null }, out);
    if (!out.texts.length) throw new ExtractError('The selection has no text to read.');
    return build(doc, out, docTitle, 'selection');
  }

  const article = articleElements(doc);
  if (article && doc.body) {
    const out = new Collector();
    const filter: TextFilter = (t) => (t.parentElement && article.kept.has(t.parentElement) ? ALL(t) : []);
    walk(doc.body, { layout, exclude, filter, within: withAncestors(article.kept) }, out);
    if (out.texts.length >= (options.minArticleWords ?? 50)) {
      return build(doc, out, cleanTitle(article.title) || docTitle, 'article');
    }
  }

  const out = new Collector();
  walk(pageRoot(doc), { layout, exclude, filter: ALL, within: null }, out);
  if (!out.texts.length) throw new ExtractError('This page has no text to read.');
  return build(doc, out, docTitle, 'page');
}

function build(doc: Document, out: Collector, title: string, source: ExtractSource): PageText {
  const paragraphs: string[] = [];
  let start = 0;
  for (const end of out.paraEnds) {
    paragraphs.push(out.texts.slice(start, end).join(' '));
    start = end;
  }
  const text = paragraphs.join(PARAGRAPH_BREAK);
  const words = segment(text);
  const { chunks, first } = chunksOf(words);
  if (chunks.length !== out.texts.length || chunks.some((c, i) => c !== out.texts[i])) {
    throw new ExtractError('The page text could not be matched to its words.');
  }

  const n = chunks.length;
  const chunkOf = new Int32Array(words.length);
  for (let c = 0; c < n; c++) chunkOf.fill(c, first[c], first[c + 1]);

  const runs: [number, number, number][] = [];
  for (let c = 0; c < n; c++) {
    const b = out.bits[c];
    if (!b) continue;
    const last = runs[runs.length - 1];
    if (last && last[1] === first[c] && last[2] === b) last[1] = first[c + 1];
    else runs.push([first[c], first[c + 1], b]);
  }
  const format: DocFormat | null = runs.length ? { v: 1, runs, links: [], blocks: [] } : null;

  const { nodes, sN, sO, eN, eO } = out;

  const point = (c: number, end: boolean): Range => {
    const r = doc.createRange();
    if (end) r.setStart(nodes[eN[c]], eO[c]);
    else r.setStart(nodes[sN[c]], sO[c]);
    return r;
  };
  /** Where (node, offset) lies relative to a chunk boundary: negative before, 0 at, positive after. */
  const compare = (c: number, end: boolean, node: Node, offset: number): number => {
    try {
      return point(c, end).comparePoint(node, offset);
    } catch {
      return 1;
    }
  };

  return {
    text,
    title,
    words,
    format,
    source,
    span(i, end) {
      if (i < 0 || i >= words.length || end <= i) return null;
      const a = chunkOf[i];
      const b = chunkOf[Math.min(end, words.length) - 1];
      const sNode = nodes[sN[a]];
      const eNode = nodes[eN[b]];
      if (!sNode.isConnected || !eNode.isConnected) return null;
      try {
        const r = doc.createRange();
        r.setStart(sNode, sO[a]);
        r.setEnd(eNode, eO[b]);
        return r;
      } catch {
        return null; // the text changed length under us
      }
    },
    wordAt(node, offset, exact = false) {
      if (!n) return -1;
      // Last chunk starting at or before the point.
      let lo = -1;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (compare(mid, false, node, offset) >= 0) lo = mid;
        else hi = mid - 1;
      }
      if (lo >= 0 && compare(lo, true, node, offset) <= 0) return first[lo];
      if (exact) return -1;
      return lo + 1 < n ? first[lo + 1] : first[n - 1];
    },
  };
}
