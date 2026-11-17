import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ReaderSession } from '../player/session';
import type { Settings } from '../settings';
import { clearSurprisalCache, loadSurprisal, savePosition, saveSurprisal, type DocMeta } from '../store/db';
import { surprisalService } from '../surprisal/client';
import { modelSpec } from '../surprisal/models';
import { summarizePace, type Pacing } from '../timing/timing';
import { Inspector } from './Inspector';
import { bufferingMessage, Problem, StatusChip } from './ModelStatus';
import { Reader } from './Reader';
import { SettingsPanel } from './SettingsPanel';

export interface OpenDoc {
  meta: DocMeta;
  text: string;
  position: number;
}

interface Props {
  doc: OpenDoc;
  settings: Settings;
  onSettings: (update: (s: Settings) => Settings) => void;
  onExit: () => void;
}

/** Cached surprisal is written at most this often while scoring. */
const SAVE_EVERY_MS = 2000;

/** One open document: its session, surprisal cache, scoring job and panels. */
export function ReaderScreen({ doc, settings, onSettings, onExit }: Props) {
  const service = surprisalService();
  const { model, job } = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const [panel, setPanel] = useState<'settings' | 'inspector' | null>(null);
  const positionRef = useRef(doc.position);
  const { modelId, backend, window } = settings;
  const { hash, id } = doc.meta;

  // Surprisal belongs to a model, so switching models starts a fresh session.
  const session = useMemo(() => new ReaderSession(doc.text, modelSpec(modelId).meanBits), [doc.text, modelId]);
  const version = useSyncExternalStore(session.subscribe, () => session.version);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dirty = false;
    const flush = () => {
      if (!dirty) return;
      dirty = false;
      void saveSurprisal(hash, modelId, session.surprisal).catch(() => {});
    };
    void (async () => {
      const cached = await loadSurprisal(hash, modelId, session.words.length).catch(() => null);
      if (cancelled) return;
      if (cached) session.applyScores(0, cached);
      if (session.complete) return;
      service.load(modelId, backend);
      service.score(session, {
        priorityWord: positionRef.current,
        window: window ? { window } : undefined,
        onProgress: () => {
          dirty = true;
          timer ??= setTimeout(() => {
            timer = undefined;
            flush();
          }, SAVE_EVERY_MS);
        },
        onDone: flush,
      });
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      flush();
      service.cancel();
    };
  }, [service, session, hash, modelId, backend, window]);

  const onPosition = useCallback(
    (i: number) => {
      positionRef.current = i;
      void savePosition(id, i).catch(() => {});
    },
    [id],
  );
  const needWord = useCallback((i: number) => service.prioritize(i), [service]);
  const closePanel = useCallback(() => setPanel(null), []);

  const fixed = settings.pacing === 'fixed';
  const pacing: Pacing = useMemo(
    () => ({ settings: settings.timing, meanS: session.mean.mean, fixed }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.timing, fixed, session, version],
  );
  const spec = modelSpec(modelId);
  const hasProblem = !fixed && !session.complete && (model.phase === 'error' || job?.phase === 'error');

  const overlay =
    panel === 'settings'
      ? () => (
          <SettingsPanel
            settings={settings}
            onSettings={onSettings}
            onClose={closePanel}
            effectiveWpm={summarizePace(session.words, session.surprisal, pacing)?.effectiveWpm}
            model={model}
            onClearCache={clearSurprisalCache}
          />
        )
      : panel === 'inspector'
        ? ({ index, jump }: { index: number; jump: (i: number) => void }) => (
            <Inspector session={session} pacing={pacing} index={index} onJump={jump} onClose={closePanel} modelLabel={spec.label} />
          )
        : null;

  return (
    <Reader
      key={session.text.length + modelId}
      title={doc.meta.title}
      session={session}
      settings={settings}
      onSettings={onSettings}
      onExit={onExit}
      initialIndex={positionRef.current}
      onPosition={onPosition}
      onNeedWord={needWord}
      bufferingMessage={bufferingMessage(model, job)}
      problem={
        hasProblem ? (
          <Problem
            model={model}
            job={job}
            settings={settings}
            onRetry={() => {
              service.load(modelId, backend, true);
              service.restart();
            }}
            onModel={(m) => onSettings((s) => ({ ...s, modelId: m }))}
            onWasm={() => onSettings((s) => ({ ...s, backend: 'wasm' }))}
            onFixed={() => onSettings((s) => ({ ...s, pacing: 'fixed' }))}
          />
        ) : null
      }
      overlay={overlay}
      onCloseOverlay={closePanel}
      actions={
        <>
          <StatusChip model={model} job={job} session={session} fixed={fixed} modelId={modelId} />
          <button className="btn ghost" onClick={() => setPanel('inspector')} title="Surprisal of each word in this passage (I)">
            Inspect
          </button>
          <button className="btn ghost" onClick={() => setPanel('settings')} title="Settings (S)">
            Settings
          </button>
        </>
      }
      onKey={(key) => {
        if (key === 'i') setPanel('inspector');
        else if (key === 's') setPanel('settings');
        else return false;
        return true;
      }}
    />
  );
}
