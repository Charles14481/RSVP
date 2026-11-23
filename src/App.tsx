import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { normalizeText, segment } from './segment/segment';
import { applyUrlOverrides, DEFAULT_SETTINGS, resolveTheme, type Settings } from './settings';
import {
  addDoc,
  clearSurprisalCache,
  deleteDoc,
  getDoc,
  listDocs,
  loadSettings,
  saveSettings,
  seedLibrary,
  updateDoc,
  type DocSource,
  type LibraryEntry,
} from './store/db';
import { surprisalService } from './surprisal/service';
import { GUIDE_TEXT, GUIDE_TITLE } from './ui/guide';
import { ImportPreview, type ImportDraft } from './ui/ImportPreview';
import { Library } from './ui/Library';
import { ReaderScreen, type OpenDoc } from './ui/ReaderScreen';
import { SAMPLE_TEXT, SAMPLE_TITLE } from './ui/sample';
import { SettingsPanel } from './ui/SettingsPanel';
import { UrlImport } from './ui/UrlImport';

type View = { kind: 'library' } | { kind: 'import'; draft: ImportDraft } | { kind: 'reader'; doc: OpenDoc };

/** Added to a new library, top first. Either can be brought back from the empty library. */
const DEFAULT_DOCS = [
  { title: GUIDE_TITLE, raw: GUIDE_TEXT, source: 'guide' },
  { title: SAMPLE_TITLE, raw: SAMPLE_TEXT, source: 'sample' },
] as const satisfies readonly { title: string; raw: string; source: DocSource }[];

function defaultDoc(d: (typeof DEFAULT_DOCS)[number]) {
  const text = normalizeText(d.raw);
  return { title: d.title, text, words: segment(text).length, source: d.source };
}

/** URL overrides are for this page load only and are never saved. */
const HAS_OVERRIDES = /[?&](backend|model)=/.test(location.search);

export function App() {
  const [settings, setSettingsState] = useState<Settings | null>(null);
  const [view, setView] = useState<View>({ kind: 'library' });
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
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
    seedLibrary(DEFAULT_DOCS.map(defaultDoc))
      .catch(() => 0)
      .then(listDocs)
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
        setMessage(`Reading ${file.name}…`);
        const { extractPdfFile } = await import('./ingest/pdfBrowser');
        let last = 0;
        const pdf = await extractPdfFile(file, (page, pages) => {
          const now = performance.now();
          if (now - last > 100 || page === pages) {
            last = now;
            setMessage(`Reading ${file.name}: page ${page} of ${pages}…`);
          }
        });
        setMessage(null);
        if (!pdf.text.trim()) {
          setMessage(`${file.name} contains no readable text.`);
          return;
        }
        setView({
          kind: 'import',
          draft: { title: pdf.title ?? title, text: pdf.text, source: 'pdf', origin: file.name, notes: pdf.notes },
        });
        return;
      }
      const text = await file.text();
      if (/\.(html?|xhtml)$/i.test(file.name) || /html/.test(file.type)) {
        const { htmlDocumentToMarkdown } = await import('./ingest/url');
        const page = htmlDocumentToMarkdown(text, `file:///${encodeURIComponent(file.name)}`);
        if (!page.markdown.trim()) {
          setMessage(`${file.name} contains no readable text.`);
          return;
        }
        setView({ kind: 'import', draft: { title: page.title || title, text: page.markdown, source: 'file', origin: file.name, format: 'markdown' } });
        return;
      }
      // Markdown files are read as Markdown; other text files are guessed from their content.
      const format = /\.(md|markdown|mdown|mkd|mkdn)$/i.test(file.name) ? 'markdown' : undefined;
      setView({ kind: 'import', draft: { title, text, source: 'file', origin: file.name, format } });
    } catch (e) {
      setMessage(e instanceof Error && /NoTextLayer|PdfError/.test(e.name) ? e.message : `Could not read ${file.name}: ${String(e)}`);
    }
  }, []);

  const openDefault = useCallback(
    async (source: 'guide' | 'sample') => {
      const existing = (await listDocs()).find((d) => d.source === source);
      if (existing) return open(existing.id);
      await save(defaultDoc(DEFAULT_DOCS.find((d) => d.source === source)!));
    },
    [open, save],
  );

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
      onUrl={() => {
        setMessage(null);
        setUrlOpen(true);
      }}
      urlForm={
        urlOpen ? (
          <UrlImport
            onClose={() => setUrlOpen(false)}
            onPaste={() => {
              setUrlOpen(false);
              setView({ kind: 'import', draft: { title: '', text: '', source: 'paste' } });
            }}
            onArticle={(a) => {
              setUrlOpen(false);
              const notes = [a.byline, a.siteName].filter(Boolean).length ? [`From ${[a.siteName, a.byline].filter(Boolean).join(', ')}.`] : undefined;
              setView({ kind: 'import', draft: { title: a.title, text: a.markdown, source: 'url', origin: a.url, notes, format: 'markdown' } });
            }}
          />
        ) : null
      }
      onGuide={() => void openDefault('guide')}
      onSample={() => void openDefault('sample')}
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
