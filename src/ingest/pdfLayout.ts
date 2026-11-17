/**
 * Turns positioned PDF text items into plain text with paragraph breaks.
 * Pure, so it can be tested on synthetic pages without pdf.js.
 *
 * 1. Per page, split two-column layouts when a clear vertical gutter exists.
 * 2. Rebuild lines from baselines (y) and order items in a line by x.
 * 3. Drop lines repeated at the top or bottom of most pages (running headers
 *    and footers) and bare page numbers.
 * 4. Join lines into paragraphs using vertical gaps, indents, short last
 *    lines and font-size changes; rejoin words hyphenated across lines.
 */

export interface PdfTextItem {
  str: string;
  /** Baseline origin in PDF user space (y grows upward). */
  x: number;
  y: number;
  width: number;
  fontSize: number;
}

export interface PdfPage {
  width: number;
  height: number;
  items: PdfTextItem[];
}

export interface Line {
  text: string;
  x: number;
  right: number;
  y: number;
  fontSize: number;
  page: number;
  /** Lines of one column on one page share a block; geometry is comparable only within it. */
  block: number;
}

export interface LayoutResult {
  text: string;
  notes: string[];
  pages: number;
  emptyPages: number;
}

export class NoTextLayerError extends Error {
  constructor() {
    super('This PDF has no text layer. It is probably a scan, and OCR is not supported in this version.');
    this.name = 'NoTextLayerError';
  }
}

const WS_ONLY = /^\s*$/;

/** Split a page's items into reading-order groups: full-width top, left, right, full-width rest. */
export function splitColumns(page: PdfPage): { groups: PdfTextItem[][]; twoColumn: boolean } {
  const items = page.items.filter((it) => !WS_ONLY.test(it.str));
  if (items.length < 12 || page.width <= 0) return { groups: [items], twoColumn: false };

  const bucket = 2;
  const n = Math.ceil(page.width / bucket) + 1;
  const cover = new Float64Array(n);
  for (const it of items) {
    const a = Math.max(0, Math.floor(it.x / bucket));
    const b = Math.min(n - 1, Math.floor((it.x + Math.max(it.width, 0)) / bucket));
    for (let k = a; k <= b; k++) cover[k] += 1;
  }
  // The widest run of buckets in the middle 30 to 70 percent of the page that
  // at most a tenth of the items cross. In two-column text only full-width
  // items (titles) cross the gutter; in single-column text nearly every line does.
  const lo = Math.floor((page.width * 0.3) / bucket);
  const hi = Math.min(n - 1, Math.ceil((page.width * 0.7) / bucket));
  const allowed = Math.max(0, Math.floor(items.length * 0.1));
  let best: [number, number] | null = null;
  for (let k = lo; k <= hi; k++) {
    if (cover[k] > allowed) continue;
    let e = k;
    while (e + 1 <= hi && cover[e + 1] <= allowed) e++;
    if (!best || e - k > best[1] - best[0]) best = [k, e];
    k = e;
  }
  const median = medianOf(items.map((it) => it.fontSize)) || 10;
  const tryGutter = (gx: number) => {
    const crossing = items.filter((it) => it.x < gx && it.x + it.width > gx);
    const rest = items.filter((it) => !(it.x < gx && it.x + it.width > gx));
    const left = rest.filter((it) => it.x + it.width / 2 < gx);
    const right = rest.filter((it) => it.x + it.width / 2 >= gx);
    const lines = (arr: PdfTextItem[]) => new Set(arr.map((it) => Math.round(it.y / (median * 0.5)))).size;
    const ok = crossing.length <= items.length * 0.15 && lines(left) >= 4 && lines(right) >= 4 && left.length >= items.length * 0.2 && right.length >= items.length * 0.2;
    return ok ? { crossing, left, right } : null;
  };

  const split = best && (best[1] - best[0] + 1) * bucket >= median * 0.8 ? tryGutter(((best[0] + best[1] + 1) / 2) * bucket) : null;
  if (!split) return { groups: [items], twoColumn: false };

  const top = Math.max(...split.left.map((it) => it.y), ...split.right.map((it) => it.y));
  const above = split.crossing.filter((it) => it.y > top);
  const below = split.crossing.filter((it) => it.y <= top);
  return { groups: [above, split.left, split.right, below].filter((g) => g.length), twoColumn: true };
}

/** Build lines from items of one reading-order group. */
export function buildLines(items: PdfTextItem[], page: number, block: number): Line[] {
  const sorted = items.filter((it) => !WS_ONLY.test(it.str)).sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: PdfTextItem[][] = [];
  for (const it of sorted) {
    const row = rows[rows.length - 1];
    if (row) {
      const ref = row[0];
      const tol = Math.max(ref.fontSize, it.fontSize) * 0.45;
      if (Math.abs(ref.y - it.y) <= tol) {
        row.push(it);
        continue;
      }
    }
    rows.push([it]);
  }
  return rows.map((row) => {
    row.sort((a, b) => a.x - b.x);
    let text = '';
    let end = -Infinity;
    for (const it of row) {
      const s = it.str;
      if (text) {
        const gap = it.x - end;
        const needsSpace = gap > it.fontSize * 0.15 && !/\s$/.test(text) && !/^\s/.test(s);
        if (needsSpace) text += ' ';
      }
      text += s;
      end = Math.max(end, it.x + it.width);
    }
    const main = row.reduce((m, it) => (it.str.length > m.str.length ? it : m), row[0]);
    return {
      text: text.replace(/\s+/g, ' ').trim(),
      x: row[0].x,
      right: end,
      y: main.y,
      fontSize: main.fontSize,
      page,
      block,
    };
  });
}

const PAGE_NUMBER = /^(?:page\s+)?(?:\d{1,4}|[ivxlcdm]{1,7})(?:\s*(?:of|\/)\s*\d{1,4})?$|^[-\u2013\u2014]\s*\d{1,4}\s*[-\u2013\u2014]$/i;

/** Normalized form for recognizing repeated headers: digits collapse so "Page 3" matches "Page 4". */
function headerKey(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/**
 * Remove running headers and footers (the same text among the first or last
 * two lines of at least half the pages) and bare page numbers at the top or
 * bottom of a page.
 */
export function dropFurniture(pages: Line[][]): { pages: Line[][]; headers: number; pageNumbers: number } {
  const edge = (lines: Line[]) => {
    const byY = [...lines].sort((a, b) => b.y - a.y);
    return new Set([...byY.slice(0, 2), ...byY.slice(-2)]);
  };
  const edges = pages.map(edge);
  const counts = new Map<string, number>();
  const textPages = pages.filter((p) => p.length).length;
  for (const set of edges) {
    const seen = new Set<string>();
    for (const l of set) seen.add(headerKey(l.text));
    for (const key of seen) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const repeated = (l: Line) => textPages >= 3 && (counts.get(headerKey(l.text)) ?? 0) >= Math.max(2, textPages * 0.5);
  let headers = 0;
  let pageNumbers = 0;
  const out = pages.map((lines, p) =>
    lines.filter((l) => {
      if (!edges[p].has(l)) return true;
      if (PAGE_NUMBER.test(l.text)) {
        pageNumbers++;
        return false;
      }
      if (repeated(l)) {
        headers++;
        return false;
      }
      return true;
    }),
  );
  return { pages: out, headers, pageNumbers };
}

const TERMINAL = /[.!?:;]["'”’)\]]*$/;
const HYPHEN_END = /\p{L}[-\u00AD\u2010]$/u;
const STARTS_LOWER = /^\p{Ll}/u;

interface BlockStats {
  left: number;
  right: number;
  gap: number;
}

function blockStats(lines: Line[]): Map<number, BlockStats> {
  const byBlock = new Map<number, Line[]>();
  for (const l of lines) {
    const arr = byBlock.get(l.block) ?? [];
    arr.push(l);
    byBlock.set(l.block, arr);
  }
  const out = new Map<number, BlockStats>();
  for (const [block, ls] of byBlock) {
    const gaps: number[] = [];
    for (let i = 1; i < ls.length; i++) {
      const g = ls[i - 1].y - ls[i].y;
      if (g > 0 && Math.abs(ls[i].fontSize - ls[i - 1].fontSize) < 0.5) gaps.push(g);
    }
    out.set(block, {
      left: percentile(ls.map((l) => l.x), 0.1),
      right: percentile(ls.map((l) => l.right), 0.9),
      gap: medianOf(gaps) || medianOf(ls.map((l) => l.fontSize)) * 1.2 || 12,
    });
  }
  return out;
}

/** Decide whether line b starts a new paragraph after line a. */
function breaksBetween(a: Line, b: Line, stats: Map<number, BlockStats>, body: number): boolean {
  const sa = stats.get(a.block)!;
  const sb = stats.get(b.block)!;
  const width = Math.max(1, sa.right - sa.left);
  const indented = b.x > sb.left + body * 0.8;
  // Ragged-right lines vary by a long word or so; a paragraph's last line is usually much shorter.
  const short = a.right < sa.right - Math.max(body * 3, width * 0.2);
  const veryShort = a.right < sa.right - width * 0.35;
  if (Math.abs(a.fontSize - b.fontSize) > body * 0.15) return true;
  if (a.block === b.block) {
    const gap = a.y - b.y;
    if (gap > sa.gap * 1.45 || gap <= 0) return true;
    if (indented && b.x > a.x + body * 0.8) return true;
  } else if (indented) {
    return true;
  }
  if (short && TERMINAL.test(a.text)) return true;
  if (veryShort && !HYPHEN_END.test(a.text)) return true;
  return false;
}

/** Join reading-ordered lines into paragraphs separated by blank lines. */
export function joinLines(lines: Line[]): { text: string; rejoined: number } {
  if (!lines.length) return { text: '', rejoined: 0 };
  const stats = blockStats(lines);
  const body = weightedMode(lines) || 10;
  const paragraphs: string[] = [];
  let current = lines[0].text;
  let rejoined = 0;
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1];
    const b = lines[i];
    if (breaksBetween(a, b, stats, body)) {
      paragraphs.push(current);
      current = b.text;
      continue;
    }
    if (HYPHEN_END.test(current) && STARTS_LOWER.test(b.text)) {
      current = current.slice(0, -1) + b.text;
      rejoined++;
    } else if (HYPHEN_END.test(current) && /^[\p{Lu}\p{N}]/u.test(b.text)) {
      current += b.text; // "Anglo-\nSaxon", "COVID-\n19": keep the hyphen, no space
    } else {
      current += ' ' + b.text;
    }
  }
  paragraphs.push(current);
  return { text: paragraphs.join('\n\n'), rejoined };
}

export function layoutPdf(pages: PdfPage[]): LayoutResult {
  let twoColumnPages = 0;
  let emptyPages = 0;
  let block = 0;
  const pageLines: Line[][] = pages.map((page, p) => {
    const { groups, twoColumn } = splitColumns(page);
    if (twoColumn) twoColumnPages++;
    const lines: Line[] = [];
    for (const g of groups) lines.push(...buildLines(g, p, block++));
    if (!lines.length) emptyPages++;
    return lines;
  });
  if (pages.length && emptyPages === pages.length) throw new NoTextLayerError();

  const { pages: cleaned, headers, pageNumbers } = dropFurniture(pageLines);
  const { text, rejoined } = joinLines(cleaned.flat().filter((l) => l.text));

  const notes: string[] = [];
  const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  if (headers) notes.push(`Removed ${plural(headers, 'repeated header or footer line')}.`);
  if (pageNumbers) notes.push(`Removed ${plural(pageNumbers, 'page number')}.`);
  if (twoColumnPages) notes.push(`Read ${plural(twoColumnPages, 'page')} as two columns.`);
  if (rejoined) notes.push(`Rejoined ${plural(rejoined, 'word')} hyphenated across lines.`);
  if (emptyPages) notes.push(`${plural(emptyPages, 'page')} had no text layer and ${emptyPages === 1 ? 'was' : 'were'} skipped (no OCR).`);
  return { text, notes, pages: pages.length, emptyPages };
}

function medianOf(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

/** The font size carrying the most characters. */
function weightedMode(lines: Line[]): number {
  const w = new Map<number, number>();
  for (const l of lines) {
    const k = Math.round(l.fontSize * 2) / 2;
    w.set(k, (w.get(k) ?? 0) + l.text.length);
  }
  let best = 0;
  let bestW = -1;
  for (const [k, v] of w) if (v > bestW) [best, bestW] = [k, v];
  return best;
}
