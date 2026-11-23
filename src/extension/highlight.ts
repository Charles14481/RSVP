import { sentenceStart } from '../segment/nav';
import type { Word } from '../types';
import type { PageText } from './extract';
import type { HighlightMode } from './settings';

/** Names of the CSS custom highlights; styled by highlight.css, which the background inserts into the page. */
export const HIGHLIGHT_CURRENT = 'rsvp-reader-current';
export const HIGHLIGHT_SENTENCE = 'rsvp-reader-sentence';
/** The sentence when it is the only mark (no word highlight): drawn stronger. */
export const HIGHLIGHT_SENTENCE_ONLY = 'rsvp-reader-sentence-only';

/** After the reader scrolls by hand, following waits this long. */
const HOLD_MS = 3000;

export interface FollowBand {
  /** Viewport y (px) the word should stay below and above. */
  top: number;
  bottom: number;
}

/**
 * Marks the words on screen in the page itself, and keeps them in view. Uses
 * the CSS Custom Highlight API, which paints over text without touching the
 * page's DOM; where that is missing, draws boxes in the overlay instead.
 */
export class PageHighlighter {
  private readonly current: Highlight | null = null;
  private readonly sentence: Highlight | null = null;
  private readonly sentenceOnly: Highlight | null = null;
  private lastSentence = -1;
  private lastMode: HighlightMode | null = null;
  private heldUntil = 0;
  private lastRange: Range | null = null;
  private lastSentenceRange: Range | null = null;
  private readonly cleanups: (() => void)[] = [];
  private frame = 0;

  constructor(
    private readonly page: PageText,
    private readonly words: readonly Word[],
    /** Fallback layer for boxes, inside the overlay's shadow root. */
    private readonly boxes: HTMLElement,
    private readonly band: () => FollowBand,
    /** Told where a followed word is, after any scrolling has been started. */
    private readonly onFollow?: (rect: DOMRect) => void,
  ) {
    const registry = typeof CSS !== 'undefined' ? CSS.highlights : undefined;
    if (registry && typeof Highlight === 'function') {
      this.current = new Highlight();
      this.current.priority = 2;
      this.sentence = new Highlight();
      this.sentence.priority = 1;
      this.sentenceOnly = new Highlight();
      this.sentenceOnly.priority = 1;
      registry.set(HIGHLIGHT_CURRENT, this.current);
      registry.set(HIGHLIGHT_SENTENCE, this.sentence);
      registry.set(HIGHLIGHT_SENTENCE_ONLY, this.sentenceOnly);
    } else {
      const redraw = () => {
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() => this.drawBoxes());
      };
      window.addEventListener('scroll', redraw, { capture: true, passive: true });
      window.addEventListener('resize', redraw, { passive: true });
      this.cleanups.push(() => {
        window.removeEventListener('scroll', redraw, { capture: true });
        window.removeEventListener('resize', redraw);
      });
    }

    // Scrolling by hand pauses following for a moment.
    const hold = () => {
      this.heldUntil = performance.now() + HOLD_MS;
    };
    const holdKey = (e: KeyboardEvent) => {
      if (['PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) hold();
    };
    const holdScrollbar = (e: MouseEvent) => {
      if (e.target === document.documentElement) hold();
    };
    window.addEventListener('wheel', hold, { passive: true, capture: true });
    window.addEventListener('touchmove', hold, { passive: true, capture: true });
    window.addEventListener('keydown', holdKey, { capture: true });
    window.addEventListener('mousedown', holdScrollbar, { capture: true });
    this.cleanups.push(() => {
      window.removeEventListener('wheel', hold, { capture: true });
      window.removeEventListener('touchmove', hold, { capture: true });
      window.removeEventListener('keydown', holdKey, { capture: true });
      window.removeEventListener('mousedown', holdScrollbar, { capture: true });
    });
  }

  /**
   * Mark words [i, end), their sentence or both (`mode`), and scroll the words
   * into view if `follow`. Following tracks the words even when only the
   * sentence is marked, so the page still moves only when it has to.
   */
  show(i: number, end: number, opts: { mode: HighlightMode; follow: boolean }): void {
    const { mode } = opts;
    const range = this.page.span(i, end);
    this.lastRange = mode === 'sentence' ? null : range;
    if (this.current) {
      this.current.clear();
      if (this.lastRange) this.current.add(this.lastRange);
    }
    const s = mode === 'word' ? -1 : sentenceStart(this.words, i);
    if (s !== this.lastSentence || mode !== this.lastMode) {
      this.lastSentence = s;
      this.lastMode = mode;
      this.lastSentenceRange = s >= 0 ? this.page.span(s, this.sentenceEnd(s)) : null;
      this.sentence?.clear();
      this.sentenceOnly?.clear();
      if (this.lastSentenceRange) (mode === 'sentence' ? this.sentenceOnly : this.sentence)?.add(this.lastSentenceRange);
    }
    if (!this.current) this.drawBoxes();
    if (range && opts.follow && performance.now() >= this.heldUntil) this.follow(range);
  }

  /** Bring words [i, end) into view now, ignoring a recent manual scroll (after a jump). */
  reveal(i: number, end: number): void {
    const range = this.page.span(i, end);
    if (range) this.follow(range, true);
  }

  clear(): void {
    this.current?.clear();
    this.sentence?.clear();
    this.sentenceOnly?.clear();
    this.lastSentence = -1;
    this.lastMode = null;
    this.lastRange = null;
    this.lastSentenceRange = null;
    if (!this.current) this.drawBoxes();
  }

  dispose(): void {
    this.clear();
    cancelAnimationFrame(this.frame);
    for (const fn of this.cleanups) fn();
    const registry = typeof CSS !== 'undefined' ? CSS.highlights : undefined;
    if (registry && registry.get(HIGHLIGHT_CURRENT) === this.current) registry.delete(HIGHLIGHT_CURRENT);
    if (registry && registry.get(HIGHLIGHT_SENTENCE) === this.sentence) registry.delete(HIGHLIGHT_SENTENCE);
    if (registry && registry.get(HIGHLIGHT_SENTENCE_ONLY) === this.sentenceOnly) registry.delete(HIGHLIGHT_SENTENCE_ONLY);
  }

  private sentenceEnd(start: number): number {
    let j = start;
    while (j < this.words.length - 1 && !this.words[j].sentenceEnd) j++;
    return j + 1;
  }

  private follow(range: Range, center = false): void {
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return; // not laid out (hidden since it was read)
    const band = this.band();
    this.onFollow?.(rect);
    if (!center && rect.top >= band.top && rect.bottom <= band.bottom) return;
    // Aim for a third of the way down the free part of the window.
    const target = band.top + (band.bottom - band.top) / 3;
    const behavior: ScrollBehavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    const scroller = scrollParent(range.startContainer.parentElement);
    if (scroller) {
      const box = scroller.getBoundingClientRect();
      const inner = Math.max(box.top, band.top) + (Math.min(box.bottom, band.bottom) - Math.max(box.top, band.top)) / 3;
      scroller.scrollBy({ top: rect.top - inner, behavior });
      // Keep the scrolling element itself on screen too.
      if (box.top > band.bottom || box.bottom < band.top) window.scrollBy({ top: box.top - target, behavior });
    } else {
      window.scrollBy({ top: rect.top - target, behavior });
    }
  }

  private drawBoxes(): void {
    const layer = this.boxes;
    layer.replaceChildren();
    const add = (range: Range | null, cls: string) => {
      if (!range) return;
      for (const r of Array.from(range.getClientRects())) {
        if (!r.width || !r.height) continue;
        const box = document.createElement('div');
        box.className = cls;
        box.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
        layer.append(box);
      }
    };
    add(this.lastSentenceRange, this.lastMode === 'sentence' ? 'hl-sentence-only' : 'hl-sentence');
    add(this.lastRange, 'hl-current');
  }
}

/** The nearest ancestor that scrolls its content vertically, other than the page itself. */
function scrollParent(el: Element | null): Element | null {
  for (let a = el; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
    if (a.scrollHeight <= a.clientHeight + 1) continue;
    const overflow = getComputedStyle(a).overflowY;
    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') return a;
  }
  return null;
}
