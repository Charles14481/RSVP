import type { PlayState } from '../player/scheduler';
import { resolveTheme, type PacingMode } from '../settings';
import { MODELS } from '../surprisal/models';
import { WPM_STEP } from '../timing/timing';
import css from './overlay.css?inline';
import type { AllSettings, ExtSettings, HighlightMode } from './settings';

export interface OverlayActions {
  toggle(): void;
  prev(): void;
  next(): void;
  wpm(delta: number): void;
  /** Seek to a fraction [0, 1] of the text. */
  seek(fraction: number): void;
  close(): void;
  wordsPerFlash(n: number): void;
  pacing(mode: PacingMode): void;
  ext(patch: Partial<ExtSettings>): void;
  /** The card was dragged here (fractions of the free space, see ExtSettings.at). */
  moved(at: { x: number; y: number }): void;
  /** The "stay open on the next page" box was ticked or cleared. */
  keepOpen(on: boolean): void;
  openOptions(): void;
}

/** A problem that holds playback, with its ways out. */
export interface ProblemView {
  title: string;
  detail?: string;
  actions: { label: string; primary?: boolean; run: () => void }[];
}

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string | boolean | ((e: Event) => void)>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, '').toLowerCase(), v as EventListener);
    else if (k === 'className') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/**
 * The floating reader: the flashing word (the same markup WordDisplay drives
 * in the app), the controls, a status line and quick settings. It lives in a
 * closed shadow root so the page's styles and scripts cannot reach it.
 */
export class Overlay {
  readonly host: HTMLElement;
  readonly stage: HTMLDivElement;
  readonly word: HTMLDivElement;
  readonly left: HTMLSpanElement;
  readonly pivot: HTMLSpanElement;
  readonly right: HTMLSpanElement;
  /** Layer for highlight boxes when the page has no CSS Custom Highlight API. */
  readonly boxes: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly problem: HTMLDivElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly wpmValue: HTMLElement;
  private readonly effective: HTMLSpanElement;
  private readonly fill: HTMLDivElement;
  private readonly label: HTMLSpanElement;
  private readonly chip: HTMLSpanElement;
  private readonly quick: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly quickRefs: {
    words: HTMLButtonElement[];
    pacing: HTMLButtonElement[];
    display: HTMLButtonElement[];
    position: HTMLButtonElement[];
    highlight: HTMLButtonElement[];
    follow: HTMLInputElement;
    keepOpen: HTMLInputElement;
  };
  private readonly keepNote: HTMLSpanElement;
  private n = 0;
  /** Where the card was dragged, while it is placed freely. */
  private at: { x: number; y: number } | null = null;
  private drag: { id: number; sx: number; sy: number; dx: number; dy: number; moving: boolean } | null = null;
  /** The click that ends a drag must not also press what it was released over. */
  private swallowClick = false;
  /** The position setting last applied, so other setting changes do not move the card. */
  private placement = '';
  private readonly resize = new ResizeObserver(() => this.replace());
  private readonly onWindowResize = () => this.replace();

  constructor(actions: OverlayActions) {
    this.host = document.createElement('rsvp-reader-overlay');
    this.host.style.setProperty('all', 'initial', 'important');
    this.host.style.setProperty('position', 'fixed', 'important');
    this.host.style.setProperty('z-index', '2147483647', 'important');
    this.host.style.setProperty('top', '0', 'important');
    this.host.style.setProperty('left', '0', 'important');
    const root = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = css;

    this.left = h('span');
    this.pivot = h('span', { className: 'pivot' });
    this.right = h('span');
    this.word = h('div', { className: 'rsvp-word', 'aria-hidden': 'true' }, this.left, this.pivot, this.right);
    this.stage = h(
      'div',
      {
        className: 'stage',
        title: 'Click or press Space to play or pause',
        onclick: (e: Event) => {
          e.stopPropagation();
          actions.toggle();
        },
      },
      h('div', { className: 'stage-guide', 'aria-hidden': 'true' }),
      this.word,
    );
    this.status = h('div', { className: 'status', role: 'status' });
    this.problem = h('div', { className: 'problem', role: 'alert', hidden: true });

    this.playBtn = h('button', { className: 'btn primary play', onclick: () => actions.toggle() }, 'Play');
    this.wpmValue = h('strong', {}, '\u2014');
    this.effective = h('span', { className: 'rate-effective', title: 'Effective rate including pauses and clamps' });
    this.fill = h('div', { className: 'progress-fill' });
    const progress = h('div', { className: 'progress', role: 'slider', 'aria-label': 'Position' }, this.fill);
    const seekFrom = (e: PointerEvent) => {
      const rect = progress.getBoundingClientRect();
      actions.seek(Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width))));
    };
    progress.addEventListener('pointerdown', (e) => {
      progress.setPointerCapture(e.pointerId);
      seekFrom(e);
    });
    progress.addEventListener('pointermove', (e) => {
      if (progress.hasPointerCapture(e.pointerId)) seekFrom(e);
    });
    this.label = h('span', { className: 'progress-label' });
    this.chip = h('span', { className: 'chip' });

    const bar = h(
      'div',
      { className: 'bar' },
      h('button', { className: 'btn ghost square', title: 'Previous sentence (Left)', 'aria-label': 'Previous sentence', onclick: () => actions.prev() }, '‹'),
      this.playBtn,
      h('button', { className: 'btn ghost square', title: 'Next sentence (Right)', 'aria-label': 'Next sentence', onclick: () => actions.next() }, '›'),
      h(
        'div',
        { className: 'rate', title: 'Target rate before pauses (Up / Down)' },
        h('button', { className: 'btn ghost square', 'aria-label': 'Slower', onclick: () => actions.wpm(-WPM_STEP) }, '−'),
        h('span', {}, this.wpmValue, ' wpm'),
        h('button', { className: 'btn ghost square', 'aria-label': 'Faster', onclick: () => actions.wpm(WPM_STEP) }, '+'),
        this.effective,
      ),
      progress,
      this.label,
      this.chip,
      h('button', { className: 'btn ghost square', title: 'Reader options', 'aria-label': 'Reader options', onclick: () => this.toggleQuick() }, '⚙'),
      h('button', { className: 'btn ghost square', title: 'Close (Esc)', 'aria-label': 'Close reader', onclick: () => actions.close() }, '×'),
    );

    const seg = <T extends string | number>(options: { value: T; label: string }[], pick: (v: T) => void) =>
      options.map((o) => h('button', { 'data-value': String(o.value), onclick: () => pick(o.value) }, o.label));
    const words = seg([1, 2, 3].map((n) => ({ value: n, label: String(n) })), (n) => actions.wordsPerFlash(n));
    const pacing = seg<PacingMode>(
      [
        { value: 'surprisal', label: 'Surprisal' },
        { value: 'fixed', label: 'Fixed rate' },
      ],
      (v) => actions.pacing(v),
    );
    const display = seg<ExtSettings['display']>(
      [
        { value: 'box', label: 'Word box + highlight' },
        { value: 'highlight', label: 'Highlight only' },
      ],
      (v) => actions.ext({ display: v }),
    );
    const position = seg<ExtSettings['position']>(
      [
        { value: 'top', label: 'Top' },
        { value: 'bottom', label: 'Bottom' },
      ],
      (v) => {
        this.placement = ''; // put it back even if the setting already says so (after a step aside)
        actions.ext({ position: v });
      },
    );
    const highlight = seg<HighlightMode>(
      [
        { value: 'both', label: 'Word + sentence' },
        { value: 'word', label: 'Word' },
        { value: 'sentence', label: 'Sentence' },
      ],
      (v) => actions.ext({ highlight: v }),
    );
    const follow = h('input', { type: 'checkbox', onchange: (e: Event) => actions.ext({ follow: (e.target as HTMLInputElement).checked }) });
    const keepOpen = h('input', { type: 'checkbox', onchange: (e: Event) => actions.keepOpen((e.target as HTMLInputElement).checked) });
    this.keepNote = h('span', { className: 'note block' });
    this.quickRefs = { words, pacing, display, position, highlight, follow, keepOpen };
    this.quick = h(
      'div',
      { className: 'quick', hidden: true },
      h('span', { className: 'label' }, 'Words at a time'),
      h('div', { className: 'segmented', role: 'group' }, ...words),
      h('span', { className: 'label' }, 'Pacing'),
      h('div', { className: 'segmented', role: 'group' }, ...pacing),
      h('span', { className: 'label' }, 'Show'),
      h('div', { className: 'segmented', role: 'group' }, ...display),
      h('span', { className: 'label' }, 'Highlight'),
      h('div', { className: 'segmented', role: 'group' }, ...highlight),
      h('span', { className: 'label' }, 'Page'),
      h(
        'div',
        {},
        h('label', { className: 'check' }, follow, 'Scroll to follow'),
        h('label', { className: 'check' }, keepOpen, 'Stay open on the next page'),
        this.keepNote,
      ),
      h('span', { className: 'label' }, 'Position'),
      h('div', { className: 'row' }, h('div', { className: 'segmented', role: 'group' }, ...position), h('span', { className: 'note' }, 'or drag the box anywhere')),
      h('span', {}),
      h('button', { className: 'link', onclick: () => actions.openOptions() }, 'All settings: pacing, model, pauses…'),
    );
    this.hint = h('div', { className: 'hint' }, 'Space play/pause · ← → sentence · ↑ ↓ speed · click a word in the page to jump · Esc close');

    this.card = h('div', { className: 'card', 'data-state': 'paused' }, this.stage, this.status, this.problem, bar, this.quick, this.hint);
    // Clicks inside the reader never reach the page.
    this.card.addEventListener('click', (e) => e.stopPropagation());
    this.card.addEventListener(
      'click',
      (e) => {
        if (!this.swallowClick) return;
        this.swallowClick = false;
        e.stopPropagation();
        e.preventDefault();
      },
      true,
    );
    this.makeDraggable(actions);
    this.boxes = h('div', { className: 'boxes', 'aria-hidden': 'true' });
    root.append(style, this.boxes, this.card);
  }

  mount(): void {
    // A child of <html> after <body>: outside the page's own content, so no page layout can clip it.
    document.documentElement.append(this.host);
    this.resize.observe(this.card);
    window.addEventListener('resize', this.onWindowResize);
  }

  unmount(): void {
    this.resize.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    this.host.remove();
  }

  setState(state: PlayState): void {
    this.card.dataset.state = state;
    const running = state === 'playing' || state === 'buffering';
    this.playBtn.textContent = running ? 'Pause' : state === 'ended' ? 'Again' : 'Play';
    this.playBtn.setAttribute('aria-label', running ? 'Pause' : 'Play');
    // Hidden but still taking its space, so the card never changes height on play or pause.
    this.hint.style.visibility = running ? 'hidden' : '';
  }

  setLength(n: number): void {
    this.n = n;
  }

  setProgress(i: number, label: string | null): void {
    const n = this.n;
    this.fill.style.transform = `scaleX(${n > 1 ? i / (n - 1) : 1})`;
    if (label !== null) this.label.textContent = label;
  }

  setRate(wpm: number, effective: number | null): void {
    this.wpmValue.textContent = String(wpm);
    this.effective.textContent = effective ? `${Math.round(effective)} effective` : '\u2014 effective';
  }

  /** The line under the word: null clears it; `meter` (0 to 1) adds a progress bar. */
  setStatus(text: string | null, opts: { spinner?: boolean; meter?: number } = {}): void {
    if (!text) {
      this.status.replaceChildren();
      return;
    }
    const parts: Node[] = [];
    if (opts.spinner) parts.push(h('span', { className: 'spinner', 'aria-hidden': 'true' }));
    parts.push(document.createTextNode(text));
    if (opts.meter !== undefined) {
      const inner = h('span');
      inner.style.transform = `scaleX(${opts.meter})`;
      parts.push(h('span', { className: 'meter', 'aria-hidden': 'true' }, inner));
    }
    this.status.replaceChildren(...parts);
  }

  setChip(text: string, title = ''): void {
    this.chip.textContent = text;
    this.chip.title = title;
  }

  setProblem(problem: ProblemView | null): void {
    if (!problem) {
      this.problem.hidden = true;
      this.problem.replaceChildren();
      return;
    }
    this.problem.hidden = false;
    const detail = problem.detail ? [h('p', { className: 'detail' }, problem.detail)] : [];
    this.problem.replaceChildren(
      h('p', {}, h('strong', {}, problem.title)),
      ...detail,
      h(
        'div',
        { className: 'row' },
        ...problem.actions.map((a) => h('button', { className: a.primary ? 'btn primary' : 'btn', onclick: () => a.run() }, a.label)),
      ),
    );
  }

  /** Font size, theme, layout and the quick settings' state. */
  apply({ settings, ext }: AllSettings): void {
    const card = this.card;
    card.dataset.theme = resolveTheme(settings.theme);
    card.dataset.display = ext.display;
    // Only a change of the position setting moves the card: other settings (speed, theme…) leave
    // it where it is, including after it stepped aside with flip().
    const placement = JSON.stringify([ext.position, ext.at]);
    if (placement !== this.placement) {
      this.placement = placement;
      if (ext.position === 'custom' && ext.at) {
        this.at = ext.at;
        card.dataset.position = 'custom';
      } else {
        this.at = null;
        card.dataset.position = ext.position;
        card.style.left = '';
        card.style.top = '';
      }
    }
    this.stage.style.fontSize = `min(${settings.fontSize}px, 12vw)`;
    const mark = (buttons: HTMLButtonElement[], value: string | number) => {
      for (const b of buttons) {
        const on = b.dataset.value === String(value);
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      }
    };
    mark(this.quickRefs.words, settings.wordsPerFlash);
    mark(this.quickRefs.pacing, settings.pacing);
    mark(this.quickRefs.display, ext.display);
    mark(this.quickRefs.position, ext.position);
    mark(this.quickRefs.highlight, ext.highlight);
    this.quickRefs.follow.checked = ext.follow;
    this.quickRefs.keepOpen.checked = ext.keepOpen;
    this.replace();
  }

  /** A short note under the keep-open box (why it is not on yet); null clears it. */
  setKeepOpenNote(text: string | null): void {
    this.keepNote.textContent = text ?? '';
  }

  /**
   * Move the card to the other edge of the window, until the position setting
   * changes. A card the reader dragged stays exactly where it was put.
   */
  flip(): void {
    if (this.at) return;
    this.card.dataset.position = this.card.dataset.position === 'bottom' ? 'top' : 'bottom';
  }

  /** Where the card is in the window, or null while it has no size. */
  rect(): DOMRect | null {
    const r = this.card.getBoundingClientRect();
    return r.width && r.height ? r : null;
  }

  /** Drag the card by any part that is not a control; a press without movement still clicks. */
  private makeDraggable(actions: OverlayActions): void {
    const card = this.card;
    card.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.drag) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('button, input, label, a, .progress, .segmented, .problem')) return;
      const r = card.getBoundingClientRect();
      this.drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, moving: false };
    });
    card.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      if (!d.moving) {
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 5) return;
        d.moving = true;
        card.setPointerCapture(e.pointerId);
        card.classList.add('dragging');
      }
      e.preventDefault();
      this.placePx(e.clientX - d.dx, e.clientY - d.dy);
    });
    const end = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      this.drag = null;
      if (!d.moving) return;
      card.classList.remove('dragging');
      // Releasing over the word would otherwise also play or pause.
      this.swallowClick = true;
      setTimeout(() => (this.swallowClick = false), 0);
      const at = this.fractions();
      this.at = at;
      actions.moved(at);
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
  }

  /** Put the card's top left corner at (left, top), kept inside the window. */
  private placePx(left: number, top: number): void {
    const card = this.card;
    const r = card.getBoundingClientRect();
    const maxX = Math.max(0, window.innerWidth - r.width);
    const maxY = Math.max(0, window.innerHeight - r.height);
    card.dataset.position = 'custom';
    card.style.left = `${Math.round(Math.max(0, Math.min(maxX, left)))}px`;
    card.style.top = `${Math.round(Math.max(0, Math.min(maxY, top)))}px`;
  }

  /** The card's place as fractions of the free space to its left and above it. */
  private fractions(): { x: number; y: number } {
    const r = this.card.getBoundingClientRect();
    const fx = r.left / Math.max(1, window.innerWidth - r.width);
    const fy = r.top / Math.max(1, window.innerHeight - r.height);
    return { x: Math.max(0, Math.min(1, fx)), y: Math.max(0, Math.min(1, fy)) };
  }

  /** Place a dragged card again after the window or the card changes size. */
  private replace(): void {
    const at = this.at;
    if (!at || this.drag?.moving) return;
    const r = this.card.getBoundingClientRect();
    if (!r.width) return;
    this.placePx(at.x * Math.max(0, window.innerWidth - r.width), at.y * Math.max(0, window.innerHeight - r.height));
  }

  private toggleQuick(): void {
    this.quick.hidden = !this.quick.hidden;
  }
}

/** Model names for the problem view's "use the other model" button. */
export function otherModel(modelId: string): { id: string; label: string } | undefined {
  return MODELS.find((m) => m.id !== modelId);
}
