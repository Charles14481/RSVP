import type { ReactNode } from 'react';
import type { ReaderSession } from '../player/session';
import type { JobStatus, ModelStatus } from '../surprisal/client';
import { MODELS, modelSpec } from '../surprisal/models';
import type { Settings } from '../settings';

const MB = 1024 * 1024;

export function loadingText(model: Extract<ModelStatus, { phase: 'loading' }>): string {
  const spec = modelSpec(model.modelId);
  if (model.total > 0) {
    const pct = Math.floor((model.loaded / model.total) * 100);
    return `Downloading ${spec.label}: ${pct}% (${Math.round(model.loaded / MB)} of ${Math.round(model.total / MB)} MB)`;
  }
  return `Loading ${spec.label}…`;
}

/** What the reader shows while it waits for surprisal. */
export function bufferingMessage(model: ModelStatus, job: JobStatus | null): ReactNode {
  if (model.phase === 'loading') {
    const frac = model.total > 0 ? model.loaded / model.total : 0;
    return (
      <span className="buffer-load">
        {loadingText(model)}
        <span className="meter" aria-hidden="true">
          <span style={{ transform: `scaleX(${frac})` }} />
        </span>
      </span>
    );
  }
  if (model.phase === 'ready' && (!job || job.phase === 'waiting')) return 'Preparing text…';
  return 'Scoring ahead…';
}

/** A compact model and scoring status for the reader's top bar. */
export function StatusChip({ model, job, session, fixed }: { model: ModelStatus; job: JobStatus | null; session: ReaderSession; fixed: boolean }) {
  let text: string;
  let title = '';
  if (model.phase === 'loading') {
    text = model.total > 0 ? `Model ${Math.floor((model.loaded / model.total) * 100)}%` : 'Loading model';
    title = loadingText(model);
  } else if (model.phase === 'error') {
    text = 'Model failed';
    title = model.message;
  } else if (model.phase === 'ready') {
    const spec = modelSpec(model.modelId);
    const scored = session.words.length ? Math.floor((session.scoredCount / session.words.length) * 100) : 100;
    text = job?.phase === 'error' ? 'Scoring failed' : scored < 100 ? `Scored ${scored}%` : spec.label;
    title = `${spec.label} on ${model.backend === 'webgpu' ? 'WebGPU' : 'WASM'} (${model.dtype}), window ${model.window.window}/${model.window.stride}${model.note ? `\n${model.note}` : ''}`;
  } else {
    text = 'No model';
  }
  return (
    <span className={`chip${fixed ? ' muted' : ''}`} title={title}>
      {fixed ? 'Fixed rate' : text}
    </span>
  );
}

interface ProblemProps {
  model: ModelStatus;
  job: JobStatus | null;
  settings: Settings;
  onRetry: () => void;
  onModel: (modelId: string) => void;
  onWasm: () => void;
  onFixed: () => void;
}

/** A blocking problem with surprisal and the ways out of it. Never falls back silently. */
export function Problem({ model, job, settings, onRetry, onModel, onWasm, onFixed }: ProblemProps): ReactNode {
  const lighter = MODELS.find((m) => m.id !== settings.modelId);
  if (model.phase === 'error') {
    return (
      <>
        <p>
          <strong>The language model could not be loaded.</strong> Surprisal pacing needs it, so playback is on hold.
        </p>
        <p className="detail">{firstLine(model.message)}</p>
        <div className="row">
          <button className="btn primary" onClick={onRetry}>
            Try again
          </button>
          {settings.backend !== 'wasm' && (
            <button className="btn" onClick={onWasm}>
              Use the CPU backend
            </button>
          )}
          {lighter && (
            <button className="btn" onClick={() => onModel(lighter.id)}>
              Use {lighter.label}
            </button>
          )}
          <button className="btn" onClick={onFixed}>
            Read at a fixed rate
          </button>
        </div>
      </>
    );
  }
  if (job?.phase === 'error') {
    const alignment = job.kind === 'alignment';
    return (
      <>
        <p>
          <strong>{alignment ? 'The text could not be matched to the model’s tokens.' : 'Scoring stopped with an error.'}</strong>{' '}
          {alignment
            ? 'This is a bug in word segmentation. Editing the text near the word below may get around it.'
            : 'Words that were already scored keep their timing.'}
        </p>
        <p className="detail">{firstLine(job.message)}</p>
        <div className="row">
          <button className="btn primary" onClick={onRetry}>
            Try again
          </button>
          <button className="btn" onClick={onFixed}>
            Read at a fixed rate
          </button>
        </div>
      </>
    );
  }
  return null;
}

function firstLine(s: string): string {
  const line = s.split('\n')[0];
  return line.length > 300 ? line.slice(0, 300) + '…' : line;
}
