import { STYLE, type BlockStyle, type DocFormat, type Word } from '../types';

/**
 * A document's stored formatting expanded for drawing: style bits and link
 * per word, block style per paragraph. Ranges outside the text are ignored,
 * so a stale or damaged record can only lose formatting, never words.
 */
export class WordStyles {
  private readonly bits: Uint8Array;
  private readonly linkOf: Int32Array;
  private readonly hrefs: string[] = [];
  private readonly blocks = new Map<number, BlockStyle>();

  private constructor(format: DocFormat, words: readonly Word[]) {
    const n = words.length;
    this.bits = new Uint8Array(n);
    this.linkOf = new Int32Array(n).fill(-1);
    for (const [start, end, bits] of format.runs ?? []) {
      for (let i = Math.max(0, start); i < Math.min(n, end); i++) this.bits[i] |= bits;
    }
    for (const [start, end, href] of format.links ?? []) {
      if (typeof href !== 'string') continue;
      const id = this.hrefs.push(href) - 1;
      for (let i = Math.max(0, start); i < Math.min(n, end); i++) this.linkOf[i] = id;
    }
    const paragraphs = n ? words[n - 1].paragraphIndex + 1 : 0;
    for (const [p, style] of format.blocks ?? []) if (p >= 0 && p < paragraphs && style?.kind) this.blocks.set(p, style);
  }

  static from(format: DocFormat | null | undefined, words: readonly Word[]): WordStyles | null {
    return format && format.v === 1 && words.length ? new WordStyles(format, words) : null;
  }

  bitsOf(i: number): number {
    return this.bits[i] ?? 0;
  }

  href(i: number): string | undefined {
    const id = this.linkOf[i];
    return id >= 0 ? this.hrefs[id] : undefined;
  }

  block(p: number): BlockStyle | undefined {
    return this.blocks.get(p);
  }
}

/** Extra class names for word i in a text view: fb bold, fi italic, fc code, fs struck, fl link. */
export function wordClass(styles: WordStyles | null | undefined, i: number): string {
  if (!styles) return '';
  const b = styles.bitsOf(i);
  let c = '';
  if (b & STYLE.bold) c += ' fb';
  if (b & STYLE.italic) c += ' fi';
  if (b & STYLE.code) c += ' fc';
  if (b & STYLE.strike) c += ' fs';
  if (styles.href(i)) c += ' fl';
  return c;
}

/** Extra class names and indent for paragraph p. */
export function paraProps(styles: WordStyles | null | undefined, p: number): { className: string; style?: { '--depth': number } } {
  const b = styles?.block(p);
  if (!b) return { className: '' };
  let c = ` f-${b.kind}`;
  if (b.quote && b.kind !== 'quote') c += ' f-quote';
  if (b.kind === 'li') {
    if (b.cont) c += ' f-cont';
    if (b.ordered) c += ' f-ordered';
  }
  return b.kind === 'li' ? { className: c, style: { '--depth': b.depth ?? 0 } } : { className: c };
}

/**
 * Style bits for the RSVP display when showing words [i, end): those every
 * word shares, so a phrase is never half-styled. Headings show in bold.
 */
export function groupBits(styles: WordStyles | null | undefined, words: readonly Word[], i: number, end: number): number {
  if (!styles || i >= end) return 0;
  let bits = 0xff;
  for (let k = i; k < end; k++) {
    let b = styles.bitsOf(k);
    if (/^h[1-6]$/.test(styles.block(words[k].paragraphIndex)?.kind ?? '')) b |= STYLE.bold;
    bits &= b;
  }
  return bits & (STYLE.bold | STYLE.italic | STYLE.code);
}

/** Open a link from the text views in a new tab, without giving the page a handle on the reader. */
export function openLink(href: string): void {
  window.open(href, '_blank', 'noopener,noreferrer');
}
