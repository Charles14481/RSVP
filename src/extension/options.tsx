import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { resolveTheme, type Settings } from '../settings';
import { SettingsPanel } from '../ui/SettingsPanel';
import '../styles.css';
import './options.css';
import type { RuntimeRequest } from './protocol';
import { ALL_SITES, loadAll, saveExt, saveSettings, watchSettings, type AllSettings, type ExtSettings } from './settings';

function Segmented<T extends string>(props: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; hint?: string }) {
  return (
    <div className="field">
      <div className="field-top">
        <span className="label">{props.label}</span>
      </div>
      <div className="segmented" role="radiogroup" aria-label={props.label}>
        {props.options.map((o) => (
          <button key={o.value} role="radio" aria-checked={o.value === props.value} className={o.value === props.value ? 'on' : ''} onClick={() => props.onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
      {props.hint && <p className="field-hint">{props.hint}</p>}
    </div>
  );
}

/**
 * Keep the reader open when the tab loads another page. Needs access to all
 * sites (the reader is put back without a click), which Firefox grants only
 * from a click here.
 */
function KeepOpen({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const [granted, setGranted] = useState<boolean | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    void browser.permissions.contains(ALL_SITES).then(setGranted);
    const update = () => void browser.permissions.contains(ALL_SITES).then(setGranted);
    browser.permissions.onAdded.addListener(update);
    browser.permissions.onRemoved.addListener(update);
    return () => {
      browser.permissions.onAdded.removeListener(update);
      browser.permissions.onRemoved.removeListener(update);
    };
  }, []);

  const checked = on && granted === true;
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          if (!e.target.checked) {
            onChange(false);
            setNote('');
            return;
          }
          // Must be called straight from the click for Firefox to show its prompt.
          void browser.permissions.request(ALL_SITES).then((ok) => {
            setGranted(ok);
            onChange(ok);
            setNote(ok ? '' : 'Firefox did not allow it, so the reader still closes when the page changes.');
          });
        }}
      />
      <span>
        Keep the reader open when the tab goes to another page
        <span className="field-hint block">
          Clicking a link or reloading opens the reader again on the new page, paused. Firefox asks to let the extension access all sites, because it puts the reader back without
          a click. Sites that change pages without loading a new one are re-read either way.
          {on && granted === false ? ' Access was removed, so this is off until you allow it again.' : ''}
          {note ? ` ${note}` : ''}
        </span>
      </span>
    </label>
  );
}

function Options() {
  const [all, setAll] = useState<AllSettings | null>(null);

  useEffect(() => {
    void loadAll().then(setAll);
    return watchSettings(setAll);
  }, []);

  useEffect(() => {
    if (all) document.documentElement.dataset.theme = resolveTheme(all.settings.theme);
  }, [all]);

  if (!all) return null;

  const onSettings = (update: (s: Settings) => Settings) => {
    const settings = update(all.settings);
    setAll({ ...all, settings });
    void saveSettings(settings);
  };
  const ext = (patch: Partial<ExtSettings>) => {
    const next = { ...all.ext, ...patch };
    setAll({ ...all, ext: next });
    void saveExt(next);
  };

  return (
    <main className="options">
      <h1>RSVP reader</h1>
      <p className="field-hint">
        Click the toolbar button (or press Alt+Shift+R) on any page to read it. Right-click to read a selection or to start from a paragraph. Space plays and pauses, ← → move by sentence, ↑ ↓ change the
        speed, Esc closes.
      </p>
      <div className="settings-page">
        <section>
          <h3>In the page</h3>
          <Segmented
            label="Show"
            value={all.ext.display}
            options={[
              { value: 'box', label: 'Word box + highlight' },
              { value: 'highlight', label: 'Highlight only' },
            ]}
            hint="The box flashes the words at a fixed point. Highlight only moves the highlight through the page at the same pace."
            onChange={(v) => ext({ display: v })}
          />
          <Segmented
            label="Highlight in the page"
            value={all.ext.highlight}
            options={[
              { value: 'both', label: 'Word + sentence' },
              { value: 'word', label: 'Word' },
              { value: 'sentence', label: 'Sentence' },
            ]}
            hint="Sentence only marks where the reader is without a highlight that moves with every word."
            onChange={(v) => ext({ highlight: v })}
          />
          <Segmented
            label="Reader position"
            value={all.ext.position}
            options={[
              { value: 'top', label: 'Top' },
              { value: 'bottom', label: 'Bottom' },
            ]}
            hint={all.ext.position === 'custom' ? 'Where you dragged it. Pick Top or Bottom to put it back.' : 'You can also drag the reader anywhere.'}
            onChange={(v) => ext({ position: v, at: null })}
          />
          <label className="check">
            <input type="checkbox" checked={all.ext.follow} onChange={(e) => ext({ follow: e.target.checked })} />
            Scroll the page to keep the word in view
          </label>
          <KeepOpen on={all.ext.keepOpen} onChange={(on) => ext({ keepOpen: on })} />
        </section>
      </div>
      <SettingsPanel
        variant="page"
        settings={all.settings}
        onSettings={onSettings}
        onClose={() => {}}
        model={{ phase: 'idle' }}
        onClearCache={() => browser.runtime.sendMessage({ type: 'clear-cache' } satisfies RuntimeRequest) as Promise<number>}
      />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
