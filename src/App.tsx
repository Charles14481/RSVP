import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { normalizeText, segment } from './segment/segment';
import { applyUrlOverrides, DEFAULT_SETTINGS, resolveTheme, type Settings } from './settings';
import { addDoc, clearSurprisalCache, deleteDoc, getDoc, listDocs, loadSettings, saveSettings, updateDoc, type LibraryEntry } from './store/db';
import { surprisalService } from './surprisal/client';
import { ImportPreview, type ImportDraft } from './ui/ImportPreview';
import { Library } from './ui/Library';
import { ReaderScreen, type OpenDoc } from './ui/ReaderScreen';
import { SAMPLE_TEXT, SAMPLE_TITLE } from './ui/sample';
import { SettingsPanel } from './ui/SettingsPanel';

type View = { kind: 'library' } | { kind: 'import'; draft: ImportDraft } | { kind: 'reader'; doc: OpenDoc };

/** URL overrides are for this page load only and are never saved. */
const HAS_OVERRIDES = /[?&](backend|model)=/.test(location.search);

export function App() {
  const [settings, setSettingsState] = useState<Settings | null>(null);
  const [view, setView] = useState<View>({ kind: 'library' });
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const service = surprisalService();
  const { model } = useSyncExternalStore(service.subscribe, service.getSnapshot);

  useEffect(() => {
    loadSettings()
      .catch(() => DEFAULT_SETTINGS)
      .then((s) => setSettingsState(applyUrlOverrides(s, location.search)));
  }, []);

  const setSettings = useCallback((update: (s: Settings) => Settings) => {
    setSettingsState((s) => (s ? update(s) : s));
  }, []);

  // Persist settings shortly after they stop changing.
  const firstSave = useRef(true);
  useEffect(() => {
    if (!settings || HAS_OVERRIDES) return;
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    const t = setTimeout(() => void saveSettings(settings).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [settings]);

  const theme = settings?.theme ?? 'system';
  useEffect(() => {
    const apply = () => (document.documentElement.dataset.theme = resolveTheme(theme));
    apply();
    if (theme !== 'system') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  const refresh = useCallback(() => {
    listDocs()
      .then(setEntries)
      .catch((e) => {
        setEntries([]);
        setMessage(`Could not open the library (${String(e)}). Storage may be disabled in this browser.`);
      });
  }, []);

  useEffect(() => {
    if (view.kind === 'library') refresh();
  }, [view.kind, refresh]);

  const open = useCallback(async (id: string) => {
    const doc = await getDoc(id);
    if (!doc) {
      setMessage('That document could not be found.');
      return;
    }
    await updateDoc(id, { openedAt: Date.now() }).catch(() => {});
    setMessage(null);
    setView({ kind: 'reader', doc });
  }, []);

  const save = useCallback(
    async (input: Parameters<typeof addDoc>[0]) => {
      setBusy(true);
      try {
        const meta = await addDoc(input);
        await open(meta.id);
      } catch (e) {
        setMessage(`Could not save the document: ${String(e)}`);
        setView({ kind: 'library' });
      } finally {
        setBusy(false);
      }
    },
    [open],
  );

  const importFile = useCallback(async (file: File) => {
    setMessage(null);
    const title = file.name.replace(/\.[^.]+$/, '');
    try {
      if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
        setMessage('PDF import arrives in the next milestone. Copy the text and paste it for now.');
        return;
      }
      const text = await file.text();
      setView({ kind: 'import', draft: { title, text, source: 'file', origin: file.name } });
    } catch (e) {
      setMessage(`Could not read ${file.name}: ${String(e)}`);
    }
  }, []);

  const openSample = useCallback(async () => {
    const existing = (await listDocs()).find((d) => d.source === 'sample');
    if (existing) return open(existing.id);
    const text = normalizeText(SAMPLE_TEXT);
    await save({ title: SAMPLE_TITLE, text, words: segment(text).length, source: 'sample' });
  }, [open, save]);

  if (!settings) return null;

  if (view.kind === 'reader') {
    return <ReaderScreen key={view.doc.meta.id} doc={view.doc} settings={settings} onSettings={setSettings} onExit={() => setView({ kind: 'library' })} />;
  }

  if (view.kind === 'import') {
    return (
      <ImportPreview
        draft={view.draft}
        targetWpm={settings.timing.targetWpm}
        busy={busy}
        onCancel={() => setView({ kind: 'library' })}
        onSave={(doc) => void save(doc)}
      />
    );
  }

  return (
    <Library
      entries={entries}
      targetWpm={settings.timing.targetWpm}
      message={message}
      onOpen={(id) => void open(id)}
      onDelete={(id) => void deleteDoc(id).then(refresh)}
      onRename={(id, title) => void updateDoc(id, { title }).then(refresh)}
      onPaste={() => setView({ kind: 'import', draft: { title: '', text: '', source: 'paste' } })}
      onFile={(f) => void importFile(f)}
      onSample={() => void openSample()}
      onSettings={() => setSettingsOpen(true)}
      overlay={
        settingsOpen ? (
          <SettingsPanel
            settings={settings}
            onSettings={setSettings}
            onClose={() => setSettingsOpen(false)}
            model={model}
            onClearCache={clearSurprisalCache}
          />
        ) : null
      }
    />
  );
}
