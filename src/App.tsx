import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ReaderSession } from './player/session';
import { normalizeText } from './segment/segment';
import { applyUrlOverrides, DEFAULT_SETTINGS, resolveTheme, type Settings } from './settings';
import { surprisalService } from './surprisal/client';
import { modelSpec } from './surprisal/models';
import { bufferingMessage, Problem, StatusChip } from './ui/ModelStatus';
import { Reader } from './ui/Reader';
import { SAMPLE_TEXT, SAMPLE_TITLE } from './ui/sample';

interface OpenDoc {
  title: string;
  text: string;
}

export function App() {
  const [settings, setSettings] = useState<Settings>(() => applyUrlOverrides(DEFAULT_SETTINGS, location.search));
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const [draft, setDraft] = useState('');
  const service = surprisalService();
  const { model, job } = useSyncExternalStore(service.subscribe, service.getSnapshot);

  useEffect(() => {
    document.documentElement.dataset.theme = resolveTheme(settings.theme);
  }, [settings.theme]);

  // Surprisal depends on the model, so a model switch starts a fresh session.
  const session = useMemo(
    () => (doc ? new ReaderSession(doc.text, modelSpec(settings.modelId).meanBits) : null),
    [doc, settings.modelId],
  );

  useEffect(() => {
    if (!session) return;
    service.load(settings.modelId, settings.backend);
    service.score(session, { priorityWord: 0, window: settings.window ? { window: settings.window } : undefined });
    return () => service.cancel();
  }, [service, session, settings.modelId, settings.backend, settings.window]);

  const exit = useCallback(() => setDoc(null), []);
  const needWord = useCallback((i: number) => service.prioritize(i), [service]);

  if (doc && session) {
    const fixed = settings.pacing === 'fixed';
    const hasProblem = !fixed && (model.phase === 'error' || job?.phase === 'error');
    const problem = !hasProblem ? null : (
      <Problem
        model={model}
        job={job}
        settings={settings}
        onRetry={() => {
          service.load(settings.modelId, settings.backend, true);
          service.restart();
        }}
        onModel={(modelId) => setSettings((s) => ({ ...s, modelId }))}
        onWasm={() => setSettings((s) => ({ ...s, backend: 'wasm' }))}
        onFixed={() => setSettings((s) => ({ ...s, pacing: 'fixed' }))}
      />
    );
    return (
      <Reader
        title={doc.title}
        session={session}
        settings={settings}
        onSettings={setSettings}
        onExit={exit}
        onNeedWord={needWord}
        bufferingMessage={bufferingMessage(model, job)}
        problem={problem}
        actions={
          <>
            <StatusChip model={model} job={job} session={session} fixed={fixed} />
            <button
              className="btn ghost"
              onClick={() => setSettings((s) => ({ ...s, pacing: fixed ? 'surprisal' : 'fixed' }))}
              title="Switch between surprisal pacing and fixed-rate RSVP"
            >
              {fixed ? 'Use surprisal' : 'Use fixed rate'}
            </button>
          </>
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
