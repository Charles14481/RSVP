import { STYLE } from '../types';
import { splitPhrase } from './orp';

/**
 * Writes words straight to the DOM, outside React render, holding the centre
 * of the pivot letter at a fixed x position. Widths come from canvas text
 * metrics so showing a word never forces a layout.
 */
export class WordDisplay {
  private readonly ctx: CanvasRenderingContext2D | null;
  private availLeft = Infinity;
  private availRight = Infinity;
  private current = '';
  private currentBits = 0;
  private fonts = { size: '', family: '', weight: '', style: '', mono: '' };

  constructor(
    private readonly stage: HTMLElement,
    private readonly wordEl: HTMLElement,
    private readonly leftEl: HTMLElement,
    private readonly pivotEl: HTMLElement,
    private readonly rightEl: HTMLElement,
  ) {
    this.ctx = document.createElement('canvas').getContext('2d');
    this.measure();
  }

  /** Re-read font and stage size. Call after a resize or a font-size change. */
  measure(): void {
    const cs = getComputedStyle(this.wordEl);
    this.fonts = {
      size: cs.fontSize,
      family: cs.fontFamily,
      weight: cs.fontWeight,
      style: cs.fontStyle,
      mono: cs.getPropertyValue('--mono-font').trim() || 'monospace',
    };
    const pivotX = this.wordEl.offsetLeft;
    const margin = 12;
    this.availLeft = Math.max(1, pivotX - margin);
    this.availRight = Math.max(1, this.stage.clientWidth - pivotX - margin);
    if (this.current) this.show(this.current, this.currentBits);
  }

  /** Show a word or phrase; `bits` (STYLE) sets it in bold, italics or code type. */
  show(text: string, bits = 0): void {
    this.current = text;
    this.currentBits = bits;
    const el = this.wordEl;
    el.classList.toggle('fb', Boolean(bits & STYLE.bold));
    el.classList.toggle('fi', Boolean(bits & STYLE.italic));
    el.classList.toggle('fc', Boolean(bits & STYLE.code));
    if (this.ctx) {
      // Must match the .rsvp-word.fb/.fi/.fc rules so widths are measured in the font shown.
      const f = this.fonts;
      const weight = bits & STYLE.bold ? '700' : f.weight;
      const style = bits & STYLE.italic ? 'italic' : f.style;
      this.ctx.font = `${style} ${weight} ${f.size} ${bits & STYLE.code ? f.mono : f.family}`;
    }
    const { left, pivot, right } = splitPhrase(text);
    this.leftEl.textContent = left;
    this.pivotEl.textContent = pivot;
    this.rightEl.textContent = right;

    const leftW = this.width(left);
    const pivotW = this.width(pivot);
    const offset = leftW + pivotW / 2;
    const rightExtent = pivotW / 2 + this.width(right);
    // Shrink words that would run off either edge, keeping the pivot fixed.
    const scale = Math.min(1, this.availLeft / Math.max(offset, 1), this.availRight / Math.max(rightExtent, 1));
    const style = this.wordEl.style;
    style.transformOrigin = `${offset}px 50%`;
    style.transform = scale < 1 ? `translateX(${-offset}px) scale(${scale})` : `translateX(${-offset}px)`;
  }

  private width(s: string): number {
    if (!s || !this.ctx) return 0;
    return this.ctx.measureText(s).width;
  }
}
