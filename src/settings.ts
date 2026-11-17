import { DEFAULT_TIMING, type TimingSettings } from './timing/timing';

export type PacingMode = 'surprisal' | 'fixed';
export type Theme = 'system' | 'light' | 'dark';

export interface Settings {
  timing: TimingSettings;
  /** 'fixed' is classic constant-rate RSVP, chosen explicitly by the user. */
  pacing: PacingMode;
  /** After a pause, resume from the start of the current sentence. */
  resumeAtSentenceStart: boolean;
  /** RSVP word size in px. */
  fontSize: number;
  theme: Theme;
}

export const DEFAULT_SETTINGS: Settings = {
  timing: DEFAULT_TIMING,
  pacing: 'surprisal',
  resumeAtSentenceStart: true,
  fontSize: 44,
  theme: 'system',
};

/** Merge stored settings over defaults so new fields get default values. */
export function mergeSettings(stored: unknown): Settings {
  if (!stored || typeof stored !== 'object') return DEFAULT_SETTINGS;
  const s = stored as Partial<Settings>;
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    timing: { ...DEFAULT_TIMING, ...(s.timing ?? {}) },
  };
}

export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  const prefersDark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'dark' : 'light';
}
