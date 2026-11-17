import { DEFAULT_MODEL_ID, type BackendPreference } from './surprisal/models';
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
  modelId: string;
  /** 'auto' tries WebGPU first; 'wasm' forces the CPU backend. */
  backend: BackendPreference;
  /** Context window in tokens; 0 = the backend's default. */
  window: number;
  /** Boundary-corrected word probabilities (Pimentel & Meister 2024; Oh & Schuler 2024). */
  boundaryCorrection: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  timing: DEFAULT_TIMING,
  pacing: 'surprisal',
  resumeAtSentenceStart: true,
  fontSize: 44,
  theme: 'system',
  modelId: DEFAULT_MODEL_ID,
  backend: 'auto',
  window: 0,
  boundaryCorrection: false,
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

/** `?backend=wasm` and `?model=<id>` override settings for this page load (debugging, smoke tests). */
export function applyUrlOverrides(s: Settings, search: string): Settings {
  const q = new URLSearchParams(search);
  const backend = q.get('backend');
  const model = q.get('model');
  return {
    ...s,
    ...(backend === 'wasm' || backend === 'auto' ? { backend } : {}),
    ...(model ? { modelId: model } : {}),
  };
}

export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  const prefersDark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'dark' : 'light';
}
