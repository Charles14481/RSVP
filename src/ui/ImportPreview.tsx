import { useDeferredValue, useMemo, useState } from 'react';
import { segmentText } from '../segment/segment';
import type { DocSource } from '../store/db';
import { formatCount, formatDuration } from './format';

export interface ImportDraft {
  title: string;
  text: string;
  source: DocSource;
  origin?: string;
  /** Shown above the editor, e.g. what the PDF extractor dropped. */
  notes?: string[];
}

interface Props {
  draft: ImportDraft;
  targetWpm: number;
  onCancel: () => void;
  onSave: (doc: { title: string; text: string; words: number; source: DocSource; origin?: string }) => void;
  busy?: boolean;
}

/**
 * Every import ends here: the extracted text in an editor so junk (headers,
 * references, captions) can be trimmed before reading. Paragraphs are
 * separated by blank lines.
 */
export function ImportPreview({ draft, targetWpm, onCancel, onSave, busy }: Props) {
  const [title, setTitle] = useState(draft.title);
  const [text, setText] = useState(draft.text);
  const deferred = useDeferredValue(text);
  const stats = useMemo(() => {
    const { text: normalized, words } = segmentText(deferred);
    const paragraphs = words.length ? words[words.length - 1].paragraphIndex + 1 : 0;
    return { normalized, words: words.length, paragraphs };
  }, [deferred]);
  const stale = deferred !== text;
  const empty = !text.trim();

  return (
    <div className="page import">
      <div className="row spread">
        <button className="btn ghost" onClick={onCancel}>
          ← Back
        </button>
        <span className="field-hint">Edit freely: remove headers, references or anything you do not want to read.</span>
      </div>
      <label className="title-field">
        <span className="label">Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled" />
      </label>
      {draft.notes?.length ? (
        <ul className="notes">
          {draft.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      <textarea
        className="paste tall"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste or type text here. Leave a blank line between paragraphs."
        autoFocus={!draft.text}
        spellCheck={false}
      />
      <div className="row spread">
        <span className={`field-hint${stale ? ' stale' : ''}`}>
          {formatCount(stats.words)} words · {formatCount(stats.paragraphs)} paragraphs · about{' '}
          {formatDuration((stats.words / targetWpm) * 60000)} at {targetWpm} wpm
        </span>
        <button
          className="btn primary"
          disabled={empty || busy}
          onClick={() => {
            const { text: normalized, words } = segmentText(text);
            if (!words.length) return;
            onSave({ title: title.trim() || 'Untitled', text: normalized, words: words.length, source: draft.source, origin: draft.origin });
          }}
        >
          Save and read
        </button>
      </div>
    </div>
  );
}
