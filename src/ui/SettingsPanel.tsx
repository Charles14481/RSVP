import { useState, type ReactNode } from 'react';
import { DEFAULT_SETTINGS, type Settings } from '../settings';
import type { ModelStatus } from '../surprisal/client';
import { MODELS } from '../surprisal/models';
import { DEFAULT_TIMING, WPM_MAX, WPM_MIN, WPM_STEP, type TimingSettings } from '../timing/timing';
import { Panel } from './Panel';

interface Props {
  settings: Settings;
  onSettings: (update: (s: Settings) => Settings) => void;
  onClose: () => void;
  /** Effective rate of the open document, if any. */
  effectiveWpm?: number | null;
  model: ModelStatus;
  onClearCache: () => Promise<number>;
  /** 'page': a plain page (the browser extension's options) without the drawer or the app-only rows. */
  variant?: 'panel' | 'page';
}

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  hint?: ReactNode;
  onChange: (v: number) => void;
}) {
  const id = `s-${props.label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="field">
      <div className="field-top">
        <label htmlFor={id}>{props.label}</label>
        <output htmlFor={id}>{props.format ? props.format(props.value) : props.value}</output>
      </div>
      <input
        id={id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      {props.hint && <p className="field-hint">{props.hint}</p>}
    </div>
  );
}

function Choice<T extends string | number>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  hint?: ReactNode;
}) {
  return (
    <div className="field">
      <div className="field-top">
        <span className="label">{props.label}</span>
      </div>
      <div className="segmented" role="radiogroup" aria-label={props.label}>
        {props.options.map((o) => (
          <button
            key={String(o.value)}
            role="radio"
            aria-checked={o.value === props.value}
            className={o.value === props.value ? 'on' : ''}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {props.hint && <p className="field-hint">{props.hint}</p>}
    </div>
  );
}

const fixed = (digits: number) => (v: number) => v.toFixed(digits);
const times = (v: number) => `${v.toFixed(2)} × T`;

export function SettingsPanel({ settings, onSettings, onClose, effectiveWpm, model, onClearCache, variant = 'panel' }: Props) {
  const appOnly = variant === 'panel';
  const [cacheNote, setCacheNote] = useState('');
  const t = settings.timing;
  const T = 60000 / t.targetWpm;
  const timing = (patch: Partial<TimingSettings>) => onSettings((s) => ({ ...s, timing: { ...s.timing, ...patch } }));
  const set = (patch: Partial<Settings>) => onSettings((s) => ({ ...s, ...patch }));
  const surprisal = settings.pacing === 'surprisal';

  const body = (
    <>
      <section>
        <h3>Pace</h3>
        <Slider
          label="Target rate"
          value={t.targetWpm}
          min={WPM_MIN}
          max={WPM_MAX}
          step={WPM_STEP}
          format={(v) => `${v} wpm`}
          hint={
            <>
              Before pauses. One beat T = {Math.round(T)} ms.
              {effectiveWpm ? ` With pauses and clamps this document reads at about ${Math.round(effectiveWpm)} wpm.` : ''}
            </>
          }
          onChange={(v) => timing({ targetWpm: v })}
        />
        <Choice
          label="Pacing"
          value={settings.pacing}
          options={[
            { value: 'surprisal', label: 'Surprisal' },
            { value: 'fixed', label: 'Fixed rate' },
          ]}
          hint="Fixed rate is classic RSVP: every word gets one beat, plus punctuation pauses."
          onChange={(v) => set({ pacing: v })}
        />
        <Choice
          label="Words at a time"
          value={settings.wordsPerFlash}
          options={[
            { value: 1, label: '1' },
            { value: 2, label: '2' },
            { value: 3, label: '3' },
          ]}
          hint="Short phrases shown together (keys 1, 2, 3). A group ends at punctuation and stays up for the total time of its words, so the pace does not change."
          onChange={(v) => set({ wordsPerFlash: v })}
        />
        <Slider
          label="Surprisal strength"
          value={t.strength}
          min={0}
          max={1}
          step={0.05}
          format={fixed(2)}
          hint="How much of each word's time follows its surprisal. 0 is fixed rate."
          onChange={(v) => timing({ strength: v })}
        />
        <Slider
          label="Spillover"
          value={t.spillover}
          min={0}
          max={0.9}
          step={0.05}
          format={fixed(2)}
          hint="Share of a word's surprisal carried onto the next word, as readers keep processing after moving on."
          onChange={(v) => timing({ spillover: v })}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={settings.resumeAtSentenceStart}
            onChange={(e) => set({ resumeAtSentenceStart: e.target.checked })}
          />
          Resume from the start of the sentence after a pause
        </label>
      </section>

      <section className={surprisal ? '' : 'dim'}>
        <h3>Word durations</h3>
        <Slider label="Shortest word" value={t.minMs} min={20} max={400} step={10} format={(v) => `${v} ms`} onChange={(v) => timing({ minMs: v })} />
        <Slider
          label="Longest word"
          value={t.maxFactor}
          min={1.5}
          max={10}
          step={0.25}
          format={(v) => `${v.toFixed(2)} × T (${Math.round(v * T)} ms)`}
          onChange={(v) => timing({ maxFactor: v })}
        />
        <Slider
          label="Length weight"
          value={t.lengthMsPerChar}
          min={0}
          max={30}
          step={1}
          format={(v) => `${v} ms per letter`}
          hint={`Added for each character beyond ${t.lengthThreshold}.`}
          onChange={(v) => timing({ lengthMsPerChar: v })}
        />
      </section>

      <section>
        <h3>Pauses</h3>
        <Slider label="Comma, colon, dash" value={t.pauseClause} min={0} max={3} step={0.25} format={times} onChange={(v) => timing({ pauseClause: v })} />
        <Slider label="Sentence end" value={t.pauseSentence} min={0} max={4} step={0.25} format={times} onChange={(v) => timing({ pauseSentence: v })} />
        <Slider label="Paragraph end" value={t.pauseParagraph} min={0} max={6} step={0.25} format={times} onChange={(v) => timing({ pauseParagraph: v })} />
      </section>

      <section>
        <h3>Model</h3>
        <Choice
          label="Language model"
          value={settings.modelId}
          options={MODELS.map((m) => ({ value: m.id, label: m.label }))}
          hint={MODELS.find((m) => m.id === settings.modelId)?.description}
          onChange={(v) => set({ modelId: v })}
        />
        <Choice
          label="Backend"
          value={settings.backend}
          options={[
            { value: 'auto', label: 'WebGPU if available' },
            { value: 'wasm', label: 'CPU (WASM)' },
          ]}
          hint={
            model.phase === 'ready'
              ? `Running on ${model.backend === 'webgpu' ? 'WebGPU' : 'WASM'} with ${model.dtype} weights.`
              : model.phase === 'error'
                ? 'The model failed to load.'
                : undefined
          }
          onChange={(v) => set({ backend: v })}
        />
        <Choice
          label="Context window"
          value={settings.window}
          options={[
            { value: 0, label: 'Auto' },
            { value: 256, label: '256' },
            { value: 512, label: '512' },
            { value: 1024, label: '1024' },
          ]}
          hint="Tokens of context per forward pass. Auto is 512 on WebGPU and 256 on WASM. Larger windows use more memory; cached words keep their scores."
          onChange={(v) => set({ window: v })}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={settings.boundaryCorrection}
            onChange={(e) => set({ boundaryCorrection: e.target.checked })}
          />
          <span>
            Boundary-corrected word probabilities
            <span className="field-hint block">
              Experimental. Accounts for where a word ends, not just how its tokens start (Pimentel &amp; Meister 2024; Oh &amp; Schuler 2024).
              Rescores the document.
            </span>
          </span>
        </label>
        <div className="row">
          <button
            className="btn"
            onClick={async () => {
              const n = await onClearCache();
              setCacheNote(n ? `Cleared ${n} cached ${n === 1 ? 'document' : 'documents'}.` : 'The cache was already empty.');
            }}
          >
            Clear surprisal cache
          </button>
          {cacheNote && <span className="field-hint">{cacheNote}</span>}
        </div>
      </section>

      <section>
        <h3>Display</h3>
        <Slider label="Word size" value={settings.fontSize} min={24} max={96} step={2} format={(v) => `${v} px`} onChange={(v) => set({ fontSize: v })} />
        <Choice
          label="Theme"
          value={settings.theme}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
          onChange={(v) => set({ theme: v })}
        />
        {appOnly && (
          <>
            <label className="check">
              <input type="checkbox" checked={settings.textWhilePlaying} onChange={(e) => set({ textWhilePlaying: e.target.checked })} />
              <span>
                Show the text while playing
                <span className="field-hint block">The text stays below the word, dimmed, with the current word marked.</span>
              </span>
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.inspectorFullText} onChange={(e) => set({ inspectorFullText: e.target.checked })} />
              <span>
                Inspector shows the whole text
                <span className="field-hint block">Scroll through the document in the inspector. Off shows two paragraphs either side.</span>
              </span>
            </label>
          </>
        )}
      </section>

      <div className="row panel-foot">
        <button
          className="btn danger"
          onClick={() =>
            onSettings((s) => ({ ...DEFAULT_SETTINGS, timing: { ...DEFAULT_TIMING }, modelId: s.modelId, backend: s.backend }))
          }
        >
          Reset to defaults
        </button>
        <span className="field-hint">Keeps the model and backend.</span>
      </div>
    </>
  );

  if (variant === 'page') return <div className="settings-page">{body}</div>;
  return (
    <Panel title="Settings" onClose={onClose}>
      {body}
    </Panel>
  );
}
