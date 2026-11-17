import { useCallback, useEffect, useMemo, useState } from 'react';
import { ReaderSession } from './player/session';
import { normalizeText } from './segment/segment';
import { DEFAULT_SETTINGS, resolveTheme, type Settings } from './settings';
import { PLACEHOLDER_MEAN_BITS, placeholderSurprisal } from './surprisal/placeholder';
import { Reader } from './ui/Reader';
import { SAMPLE_TEXT, SAMPLE_TITLE } from './ui/sample';

interface OpenDoc {
  title: string;
  text: string;
}

export function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    document.documentElement.dataset.theme = resolveTheme(settings.theme);
  }, [settings.theme]);

  const session = useMemo(() => {
    if (!doc) return null;
    const s = new ReaderSession(doc.text, PLACEHOLDER_MEAN_BITS);
    s.applyScores(0, placeholderSurprisal(s.words));
    return s;
  }, [doc]);

  const exit = useCallback(() => setDoc(null), []);

  if (doc && session) {
    return (
      <Reader
        title={doc.title}
        session={session}
        settings={settings}
        onSettings={setSettings}
        onExit={exit}
        actions={
          <button
            className="btn ghost"
            onClick={() => setSettings((s) => ({ ...s, pacing: s.pacing === 'fixed' ? 'surprisal' : 'fixed' }))}
            title="Switch between surprisal pacing and fixed-rate RSVP"
          >
            {settings.pacing === 'fixed' ? 'Fixed rate' : 'Surprisal'}
          </button>
        }
      />
    );
  }

  const start = (title: string, raw: string) => {
    const text = normalizeText(raw);
    if (text) setDoc({ title, text });
  };

  return (
    <div className="page">
      <h1>Surprisal Reader</h1>
      <p className="lede">Paste some text and read it one word at a time.</p>
      <textarea
        className="paste"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Paste text here"
        rows={12}
      />
      <div className="row">
        <button className="btn primary" disabled={!draft.trim()} onClick={() => start('Pasted text', draft)}>
          Read
        </button>
        <button className="btn" onClick={() => start(SAMPLE_TITLE, SAMPLE_TEXT)}>
          Try the sample
        </button>
      </div>
    </div>
  );
}
