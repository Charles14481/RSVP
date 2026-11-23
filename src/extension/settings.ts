import { mergeSettings, type Settings } from '../settings';

/** What is marked in the page: the words on screen, their sentence, or both. */
export type HighlightMode = 'both' | 'word' | 'sentence';

/** Options that only the browser extension has. */
export interface ExtSettings {
  /** 'box': the flashing word plus the highlight in the page; 'highlight': only the highlight. */
  display: 'box' | 'highlight';
  highlight: HighlightMode;
  /** Scroll the page to keep the highlighted word in view. */
  follow: boolean;
  /** Where the reader sits: an edge of the window, or where it was dragged ('custom', see `at`). */
  position: 'top' | 'bottom' | 'custom';
  /**
   * Where the reader was dragged, as fractions (0 to 1) of the free space to
   * its left and above it, so it stays in place proportionally when the
   * window is resized.
   */
  at: { x: number; y: number } | null;
  /** Open the reader again after the tab loads another page (needs access to all sites). */
  keepOpen: boolean;
}

export const DEFAULT_EXT: ExtSettings = {
  display: 'box',
  highlight: 'both',
  follow: true,
  position: 'top',
  at: null,
  keepOpen: false,
};

const unit = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null);

export function mergeExt(stored: unknown): ExtSettings {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Partial<ExtSettings> & { highlightSentence?: boolean };
  const x = unit(s.at?.x);
  const y = unit(s.at?.y);
  const at = x !== null && y !== null ? { x, y } : null;
  let highlight: HighlightMode = DEFAULT_EXT.highlight;
  if (s.highlight === 'both' || s.highlight === 'word' || s.highlight === 'sentence') highlight = s.highlight;
  else if (s.highlightSentence === false) highlight = 'word'; // the earlier on/off setting
  return {
    display: s.display === 'highlight' ? 'highlight' : 'box',
    highlight,
    follow: typeof s.follow === 'boolean' ? s.follow : DEFAULT_EXT.follow,
    position: s.position === 'bottom' ? 'bottom' : s.position === 'custom' && at ? 'custom' : 'top',
    at,
    keepOpen: s.keepOpen === true,
  };
}

export interface AllSettings {
  settings: Settings;
  ext: ExtSettings;
}

const KEYS = { settings: 'settings', ext: 'ext' } as const;

/** Settings live in storage.local, which the content scripts, background and options page all share. */
export async function loadAll(): Promise<AllSettings> {
  const stored = await browser.storage.local.get([KEYS.settings, KEYS.ext]).catch(() => ({}) as Record<string, unknown>);
  return { settings: mergeSettings(stored[KEYS.settings]), ext: mergeExt(stored[KEYS.ext]) };
}

export function saveSettings(settings: Settings): Promise<void> {
  return browser.storage.local.set({ [KEYS.settings]: settings });
}

export function saveExt(ext: ExtSettings): Promise<void> {
  return browser.storage.local.set({ [KEYS.ext]: ext });
}

/** Calls back with the merged settings after any change; returns an unsubscribe function. */
export function watchSettings(cb: (all: AllSettings) => void): () => void {
  const listener = (changes: Record<string, browser.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !(KEYS.settings in changes || KEYS.ext in changes)) return;
    void loadAll().then(cb);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

/** Host access the keep-open setting needs: the reader is put back after the tab loads another page. */
export const ALL_SITES: browser.permissions.Permissions = { origins: ['<all_urls>'] };
