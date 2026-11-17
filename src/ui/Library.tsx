import { useRef, useState, type ReactNode } from 'react';
import type { LibraryEntry } from '../store/db';
import { formatCount, formatDuration } from './format';

interface Props {
  entries: LibraryEntry[] | null;
  targetWpm: number;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onPaste: () => void;
  onFile: (file: File) => void;
  onUrl?: () => void;
  onSample: () => void;
  onSettings: () => void;
  /** Shown above the list (import errors). */
  message?: ReactNode;
  /** The URL import form, when open. */
  urlForm?: ReactNode;
  overlay?: ReactNode;
}

const FILE_TYPES = '.txt,.text,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf';

export function Library(props: Props) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const entries = props.entries;

  return (
    <div className="page library">
      <header className="lib-head">
        <div>
          <h1>Surprisal Reader</h1>
          <p className="lede">One word at a time, paced by how predictable each word is.</p>
        </div>
        <button className="btn ghost" onClick={props.onSettings}>
          Settings
        </button>
      </header>

      <div className="row import-row">
        <button className="btn primary" onClick={props.onPaste}>
          Paste text
        </button>
        <button className="btn" onClick={() => fileRef.current?.click()}>
          Open a file
        </button>
        {props.onUrl && (
          <button className="btn" onClick={props.onUrl}>
            From a web page
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept={FILE_TYPES}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) props.onFile(f);
          }}
        />
        <span className="field-hint">Text files and PDFs. Everything stays on this device.</span>
      </div>

      {props.urlForm}
      {props.message && <div className="banner">{props.message}</div>}

      {entries === null ? null : entries.length === 0 ? (
        <div className="empty">
          <p>Your library is empty.</p>
          <p className="field-hint">
            Paste an article or open a file to begin, or{' '}
            <button className="link" onClick={props.onSample}>
              read a short introduction
            </button>{' '}
            to how the pacing works.
          </p>
        </div>
      ) : (
        <ul className="docs">
          {entries.map((d) => {
            const done = d.words > 1 ? Math.min(1, d.position / (d.words - 1)) : 0;
            const left = Math.max(0, d.words - d.position);
            return (
              <li key={d.id} className="doc">
                <button className="doc-main" onClick={() => props.onOpen(d.id)} disabled={editing === d.id}>
                  {editing === d.id ? (
                    <input
                      className="rename"
                      defaultValue={d.title}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        if (e.key === 'Escape') {
                          (e.target as HTMLInputElement).value = d.title;
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                      onBlur={(e) => {
                        const t = e.target.value.trim();
                        if (t && t !== d.title) props.onRename(d.id, t);
                        setEditing(null);
                      }}
                    />
                  ) : (
                    <span className="doc-title">{d.title}</span>
                  )}
                  <span className="doc-meta">
                    {formatCount(d.words)} words
                    {d.origin ? ` · ${shortOrigin(d.origin)}` : ''}
                    {d.position > 0 ? ` · ${Math.round(done * 100)}% read · ${formatDuration((left / props.targetWpm) * 60000)} left` : ''}
                  </span>
                  <span className="doc-bar" aria-hidden="true">
                    <span style={{ transform: `scaleX(${done})` }} />
                  </span>
                </button>
                <div className="doc-actions">
                  <button className="btn ghost" onClick={() => setEditing(d.id)} aria-label={`Rename ${d.title}`}>
                    Rename
                  </button>
                  <button
                    className="btn ghost danger"
                    onClick={() => {
                      if (confirm(`Delete “${d.title}”? This cannot be undone.`)) props.onDelete(d.id);
                    }}
                    aria-label={`Delete ${d.title}`}
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {props.overlay}
    </div>
  );
}

function shortOrigin(origin: string): string {
  try {
    const u = new URL(origin);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return origin.length > 40 ? origin.slice(0, 37) + '…' : origin;
  }
}
