import type { PlayState } from '../player/scheduler';
import { ReaderSession } from '../player/session';
import type { Settings } from '../settings';
import { SurprisalService, type JobStatus, type ModelStatus } from '../surprisal/client';
import { modelSpec } from '../surprisal/models';
import { BackgroundConnection } from './connection';
import { PagePlayer } from './controller';
import { extractPage, type PageText } from './extract';
import { PageHighlighter, type FollowBand } from './highlight';
import { otherModel, Overlay, type OverlayActions, type ProblemView } from './overlay';
import { PORT_NAME, type Command, type RuntimeRequest } from './protocol';
import { loadAll, saveExt, saveSettings, watchSettings, type AllSettings, type ExtSettings } from './settings';

/**
 * Content script, injected on demand by the background page (toolbar button,
 * shortcut or context menu). Reads the page, opens the floating reader and
 * highlights each word in the page as it is shown.
 */

const MB = 1024 * 1024;
/** Cached surprisal is written at most this often while scoring. */
const SAVE_EVERY_MS = 2000;

type Mode = 'page' | 'selection';

interface Installed {
  handle(cmd: Command): void;
}

const global = window as unknown as { __rsvpReaderExtension?: Installed };

if (!global.__rsvpReaderExtension) {
  let reader: PageReader | null = null;
  const close = () => {
    reader?.close();
    reader = null;
  };
  const open = (mode: Mode, from?: Element | null) => {
    close();
    const r = new PageReader(() => {
      if (reader === r) reader = null;
    });
    reader = r;
    void r.start(mode, from ?? null);
  };
  const handle = (cmd: Command) => {
    switch (cmd.type) {
      case 'toggle':
        if (reader) close();
        else open(selectionRanges().length ? 'selection' : 'page');
        break;
      case 'read-page':
        open('page');
        break;
      case 'reopen':
        // The tab loaded a new page and the reader was open on the last one (keep-open setting).
        if (!reader) open('page');
        break;
      case 'read-selection':
        open(selectionRanges().length ? 'selection' : 'page');
        break;
      case 'read-from': {
        let el: Element | null = null;
        try {
          el = (browser.menus.getTargetElement(cmd.targetElementId) as Element | undefined) ?? null;
        } catch {
          el = null;
        }
        open('page', el);
        break;
      }
    }
  };
  browser.runtime.onMessage.addListener((msg: unknown) => {
    const cmd = msg as Command | null;
    if (cmd && ['toggle', 'read-page', 'read-selection', 'read-from', 'reopen'].includes(cmd.type)) handle(cmd);
    return undefined;
  });
  global.__rsvpReaderExtension = { handle };
}

function selectionRanges(): Range[] {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return [];
  const ranges: Range[] = [];
  for (let i = 0; i < sel.rangeCount; i++) {
    const r = sel.getRangeAt(i);
    if (!r.collapsed && r.toString().trim()) ranges.push(r);
  }
  return ranges;
}

/** The page's address without the fragment: jumping to an anchor is not a new page. */
function pageAddress(): string {
  return location.href.replace(/#.*$/, '');
}

function cacheKey(s: Settings): string {
  // Boundary-corrected values differ from plain ones, so they are cached under their own key.
  return s.boundaryCorrection ? `${s.modelId}+boundary` : s.modelId;
}

function firstLine(s: string): string {
  const line = s.split('\n')[0];
  return line.length > 300 ? line.slice(0, 300) + '…' : line;
}

function loadingText(model: Extract<ModelStatus, { phase: 'loading' }>): string {
  const spec = modelSpec(model.modelId);
  if (model.total > 0) {
    const pct = Math.floor((model.loaded / model.total) * 100);
    return `Downloading ${spec.label}: ${pct}% (${Math.round(model.loaded / MB)} of ${Math.round(model.total / MB)} MB)`;
  }
  return `Loading ${spec.label}…`;
}

/** One open reader on this page. */
class PageReader {
  private all!: AllSettings;
  private readonly overlay: Overlay;
  private readonly conn = new BackgroundConnection(() => browser.runtime.connect({ name: PORT_NAME }));
  private readonly service = new SurprisalService(() => this.conn);
  private page: PageText | null = null;
  private session: ReaderSession | null = null;
  private player: PagePlayer | null = null;
  private highlighter: PageHighlighter | null = null;
  private hash = '';
  private state: PlayState = 'paused';
  private closed = false;
  private readonly cleanups: (() => void)[] = [];
  /** Undo for the session's subscriptions. */
  private sessionCleanups: (() => void)[] = [];
  /** Stops the scoring job and writes what it scored to the cache. */
  private stopScoringFns: (() => void)[] = [];

  constructor(private readonly onClosed: () => void) {
    const actions: OverlayActions = {
      toggle: () => this.player?.toggle(),
      prev: () => this.player?.previousSentence(),
      next: () => this.player?.nextSentence(),
      wpm: (d) => this.player?.changeWpm(d),
      seek: (f) => this.player?.seekFraction(f),
      close: () => this.close(),
      wordsPerFlash: (n) => this.updateSettings((s) => ({ ...s, wordsPerFlash: n })),
      pacing: (mode) => this.updateSettings((s) => ({ ...s, pacing: mode })),
      ext: (patch) => this.updateExt(patch),
      moved: (at) => this.updateExt({ position: 'custom', at }),
      keepOpen: (on) => void this.setKeepOpen(on),
      openOptions: () => void browser.runtime.sendMessage({ type: 'open-options' } satisfies RuntimeRequest).catch(() => {}),
    };
    this.overlay = new Overlay(actions);
  }

  async start(mode: Mode, from: Element | null): Promise<void> {
    this.all = await loadAll();
    if (this.closed) return;
    const overlay = this.overlay;
    overlay.apply(this.all);
    overlay.mount();
    this.listen();
    // The background remembers which tabs have a reader open, to put it back after the tab loads another page.
    if (window === window.top) void browser.runtime.sendMessage({ type: 'reader-opened' } satisfies RuntimeRequest).catch(() => {});
    overlay.setStatus('Reading the page…', { spinner: true });

    let page: PageText;
    try {
      page = extractPage(document, { ranges: mode === 'selection' ? selectionRanges() : [], exclude: overlay.host });
    } catch (e) {
      overlay.setStatus(null);
      overlay.setProblem({
        title: e instanceof Error ? e.message : 'This page could not be read.',
        detail: 'Select the text you want to read and try again.',
        actions: [{ label: 'Close', primary: true, run: () => this.close() }],
      });
      return;
    }
    // A selection's own colour would hide the highlight.
    if (mode === 'selection') window.getSelection()?.removeAllRanges();
    this.page = page;
    await this.begin(from ? page.wordAt(from, 0) : null, mode === 'page');
  }

  /** (Re)build the session for the current model and start playing from `index` (or the saved place). */
  private async begin(index: number | null, resume: boolean): Promise<void> {
    const page = this.page;
    if (!page || this.closed) return;
    this.endSession();
    const overlay = this.overlay;
    const { settings } = this.all;
    const session = new ReaderSession(page.text, modelSpec(settings.modelId).meanBits, page.format);
    this.session = session;

    const cached = await this.conn.loadCache(page.text, cacheKey(settings), session.words.length);
    if (this.closed || this.session !== session) return;
    if (cached?.hash) this.hash = cached.hash;
    if (cached?.bits) session.applyScores(0, cached.bits);
    const n = session.words.length;
    let start = index ?? 0;
    if (index === null && resume && cached && cached.position > 0 && cached.position < n - 1) start = cached.position;

    overlay.setStatus(null);
    const highlighter = new PageHighlighter(page, session.words, overlay.boxes, () => this.band(), (rect) => this.uncover(rect));
    this.highlighter = highlighter;
    this.player = new PagePlayer(
      session,
      overlay,
      highlighter,
      () => this.all,
      {
        onNeedWord: (i) => this.service.prioritize(i),
        onPosition: (i) => {
          if (this.hash) this.conn.savePosition(this.hash, i);
        },
        onState: (s) => {
          this.state = s;
          this.updateStatus();
        },
        onSettings: (update) => this.updateSettings(update),
        onClose: () => this.close(),
      },
      start,
    );
    this.sessionCleanups.push(
      session.subscribe(() => {
        this.player?.scoresChanged();
        this.updateStatus();
      }),
    );
    this.startScoring();
    this.updateStatus();
  }

  /** Score the session unless it is complete or the pace is fixed (which needs no model). */
  private startScoring(): void {
    this.stopScoring();
    const session = this.session;
    if (!session || session.complete) return;
    const { settings } = this.all;
    if (settings.pacing === 'fixed') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dirty = false;
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      if (!dirty || !this.hash) return;
      dirty = false;
      this.conn.saveCache(this.hash, cacheKey(settings), session.surprisal);
    };
    this.service.load(settings.modelId, settings.backend);
    this.service.score(session, {
      priorityWord: this.player?.index ?? 0,
      window: settings.window ? { window: settings.window } : undefined,
      boundary: settings.boundaryCorrection,
      onProgress: () => {
        dirty = true;
        timer ??= setTimeout(flush, SAVE_EVERY_MS);
      },
      onDone: flush,
    });
    this.stopScoringFns.push(() => {
      flush();
      this.service.cancel();
    });
  }

  private stopScoring(): void {
    const fns = this.stopScoringFns;
    this.stopScoringFns = [];
    for (const fn of fns) fn();
  }

  private endSession(): void {
    this.stopScoring();
    for (const fn of this.sessionCleanups) fn();
    this.sessionCleanups = [];
    this.player?.dispose();
    this.player = null;
    this.highlighter?.dispose();
    this.highlighter = null;
    this.session = null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (window === window.top) void browser.runtime.sendMessage({ type: 'reader-closed' } satisfies RuntimeRequest).catch(() => {});
    this.endSession();
    for (const fn of this.cleanups) fn();
    this.conn.close();
    this.overlay.unmount();
    this.onClosed();
  }

  private listen(): void {
    const overlay = this.overlay;
    const onKey = (e: KeyboardEvent) => {
      const handled = this.player
        ? this.player.handleKey(e, overlay.host)
        : e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && (this.close(), true);
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    // A click in the page pauses; while paused, a click on a word that is being read jumps there.
    const onClick = (e: MouseEvent) => {
      const player = this.player;
      const page = this.page;
      if (!player || !page || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      if (e.composedPath().includes(overlay.host)) return;
      if (player.running) {
        player.pause();
        return;
      }
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('a, button, input, textarea, select, label, summary, [contenteditable], [role="button"], [role="link"]')) return;
      if (window.getSelection()?.isCollapsed === false) return;
      const pos = document.caretPositionFromPoint?.(e.clientX, e.clientY);
      if (!pos) return;
      const i = page.wordAt(pos.offsetNode, pos.offset, true);
      if (i >= 0) player.jump(i);
    };
    const onVisibility = () => {
      if (document.hidden) this.player?.pause();
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('visibilitychange', onVisibility);
    const unwatch = watchSettings((all) => this.applySettings(all));
    const unsubscribe = this.service.subscribe(() => this.updateStatus());
    // Sites that change pages without loading a new document keep this script and the reader,
    // but the text under it is gone: read the new page.
    let address = pageAddress();
    const addressWatch = setInterval(() => {
      const now = pageAddress();
      if (now === address) return;
      address = now;
      void this.reread();
    }, 1000);
    this.cleanups.push(() => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(addressWatch);
      unwatch();
      unsubscribe();
    });
  }

  private rereading = 0;

  /**
   * The page's address changed in place: wait for the new content, then read
   * it. Tries for a few seconds, since such sites often fill the page in after
   * changing the address.
   */
  private async reread(): Promise<void> {
    const token = ++this.rereading;
    this.player?.pause();
    const before = this.page?.text;
    for (const wait of [600, 1000, 1500, 2500]) {
      await new Promise((r) => setTimeout(r, wait));
      if (this.closed || token !== this.rereading) return;
      let page: PageText;
      try {
        page = extractPage(document, { exclude: this.overlay.host });
      } catch {
        continue;
      }
      if (page.text === before) continue;
      this.overlay.setProblem(null);
      this.page = page;
      await this.begin(null, true);
      return;
    }
  }

  private updateSettings(update: (s: Settings) => Settings): void {
    const settings = update(this.all.settings);
    this.applySettings({ ...this.all, settings });
    void saveSettings(settings).catch(() => {});
  }

  /**
   * Turning keep-open on needs access to all sites, which Firefox grants only
   * from a click in an extension page: if it is missing, the background opens
   * the options page, where the same switch asks for it.
   */
  private async setKeepOpen(on: boolean): Promise<void> {
    if (!on) {
      this.overlay.setKeepOpenNote(null);
      this.updateExt({ keepOpen: false });
      return;
    }
    const granted = await browser.runtime.sendMessage({ type: 'keep-open' } satisfies RuntimeRequest).catch(() => false);
    if (this.closed) return;
    if (granted === true) {
      this.overlay.setKeepOpenNote(null);
      this.updateExt({ keepOpen: true });
    } else {
      this.overlay.apply(this.all); // untick: it is not on yet
      this.overlay.setKeepOpenNote('Firefox has to allow this first: turn it on in the options tab that just opened.');
    }
  }

  private updateExt(patch: Partial<ExtSettings>): void {
    const ext = { ...this.all.ext, ...patch };
    this.applySettings({ ...this.all, ext });
    void saveExt(ext).catch(() => {});
  }

  /** Apply settings from this page or from storage (another tab, the options page). */
  private applySettings(next: AllSettings): void {
    if (this.closed) return;
    const prev = this.all;
    this.all = next;
    this.overlay.apply(next);
    const a = prev.settings;
    const b = next.settings;
    if (cacheKey(a) !== cacheKey(b)) {
      // Surprisal belongs to a model, so a new model means a new session.
      void this.begin(this.player?.index ?? 0, false);
      return;
    }
    if (a.backend !== b.backend || a.window !== b.window || a.pacing !== b.pacing) this.startScoring();
    this.player?.settingsChanged();
    this.updateStatus();
  }

  /**
   * Where followed words should stay: in the upper part of the larger free
   * stretch of window above or below the card.
   */
  private band(): FollowBand {
    const vh = window.innerHeight;
    const card = this.overlay.rect();
    let top = 0;
    let bottom = vh;
    if (card) {
      if (card.top >= vh - card.bottom) bottom = card.top;
      else top = card.bottom;
    }
    const lo = Math.max(top + 16, vh * 0.15);
    const hi = Math.max(lo + 80, Math.min(bottom - 16, vh * 0.65));
    return { top: lo, bottom: hi };
  }

  /**
   * A followed word under the card that scrolling cannot uncover (the first
   * lines of a page with the card near the top, the last with it near the
   * bottom): move the card to the other side. It stays there until the
   * position setting changes.
   */
  private uncover(rect: DOMRect): void {
    const card = this.overlay.rect();
    if (!card) return;
    const covered = rect.bottom > card.top && rect.top < card.bottom && rect.right > card.left && rect.left < card.right;
    if (!covered) return;
    const vh = window.innerHeight;
    const root = document.scrollingElement ?? document.documentElement;
    const atTop = root.scrollTop <= 1;
    const atBottom = root.scrollTop >= root.scrollHeight - root.clientHeight - 1;
    const middle = (rect.top + rect.bottom) / 2;
    if ((atTop && middle < vh / 2) || (atBottom && middle >= vh / 2)) this.overlay.flip();
  }

  private updateStatus(): void {
    const session = this.session;
    if (!session || this.closed) return;
    const { model, job } = this.service;
    const { settings } = this.all;
    const fixed = settings.pacing === 'fixed';
    this.overlay.setChip(...chip(model, job, session, fixed, settings.modelId));
    const problem = !fixed && !session.complete ? this.problem(model, job) : null;
    this.overlay.setProblem(problem);
    if (problem || this.state !== 'buffering') {
      this.overlay.setStatus(null);
    } else if (model.phase === 'loading') {
      this.overlay.setStatus(loadingText(model), { meter: model.total > 0 ? model.loaded / model.total : 0 });
    } else {
      this.overlay.setStatus(model.phase === 'ready' && (!job || job.phase === 'waiting') ? 'Preparing text…' : 'Scoring ahead…', { spinner: true });
    }
  }

  private problem(model: ModelStatus, job: JobStatus | null): ProblemView | null {
    const { settings } = this.all;
    const retry = { label: 'Try again', primary: true, run: () => this.retry() };
    const toFixed = { label: 'Read at a fixed rate', run: () => this.updateSettings((s) => ({ ...s, pacing: 'fixed' })) };
    if (model.phase === 'error') {
      const other = otherModel(settings.modelId);
      return {
        title: 'The language model could not be loaded. Surprisal pacing needs it, so playback is on hold.',
        detail: firstLine(model.message),
        actions: [
          retry,
          ...(settings.backend !== 'wasm' ? [{ label: 'Use the CPU backend', run: () => this.updateSettings((s) => ({ ...s, backend: 'wasm' as const })) }] : []),
          ...(other ? [{ label: `Use ${other.label}`, run: () => this.updateSettings((s) => ({ ...s, modelId: other.id })) }] : []),
          toFixed,
        ],
      };
    }
    if (job?.phase === 'error') {
      return {
        title: job.kind === 'alignment' ? 'The page text could not be matched to the model’s tokens.' : 'Scoring stopped with an error. Words already scored keep their timing.',
        detail: firstLine(job.message),
        actions: [retry, toFixed],
      };
    }
    return null;
  }

  private retry(): void {
    const { settings } = this.all;
    this.service.load(settings.modelId, settings.backend, true);
    this.startScoring();
  }
}

/** Compact model and scoring status, as the app's StatusChip. */
function chip(model: ModelStatus, job: JobStatus | null, session: ReaderSession, fixed: boolean, modelId: string): [string, string] {
  if (fixed) return ['Fixed rate', 'Every word gets one beat, plus punctuation pauses.'];
  if (session.complete) {
    const label = modelSpec(modelId).label;
    return [label, model.phase === 'ready' ? `${label}: every word scored` : `${label}: every word scored (from the cache)`];
  }
  if (model.phase === 'loading') return [model.total > 0 ? `Model ${Math.floor((model.loaded / model.total) * 100)}%` : 'Loading model', loadingText(model)];
  if (model.phase === 'error') return ['Model failed', model.message];
  if (model.phase === 'ready') {
    const spec = modelSpec(model.modelId);
    const scored = session.words.length ? Math.floor((session.scoredCount / session.words.length) * 100) : 100;
    const text = job?.phase === 'error' ? 'Scoring failed' : scored < 100 ? `Scored ${scored}%` : spec.label;
    const title = `${spec.label} on ${model.backend === 'webgpu' ? 'WebGPU' : 'WASM'} (${model.dtype}), window ${model.window.window}/${model.window.stride}${model.note ? `\n${model.note}` : ''}`;
    return [text, title];
  }
  return ['', ''];
}
