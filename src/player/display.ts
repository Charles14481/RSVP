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
    if (this.ctx) this.ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const pivotX = this.wordEl.offsetLeft;
    const margin = 12;
    this.availLeft = Math.max(1, pivotX - margin);
    this.availRight = Math.max(1, this.stage.clientWidth - pivotX - margin);
    if (this.current) this.show(this.current);
  }

  show(text: string): void {
    this.current = text;
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
