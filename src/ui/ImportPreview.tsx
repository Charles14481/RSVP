import { useDeferredValue, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type ReactNode } from 'react';
import { htmlHasFormatting, htmlStringToMarkdown } from '../ingest/html';
import { convertText, looksLikeMarkdown, type TextFormat } from '../ingest/markdown';
import { paraProps, WordStyles, wordClass } from '../segment/format';
import { segment } from '../segment/segment';
import type { DocSource } from '../store/db';
import type { DocFormat } from '../types';
import { formatCount, formatDuration } from './format';

export interface ImportDraft {
  title: string;
  text: string;
  source: DocSource;
  origin?: string;
  /** How `text` is written; guessed from the text when absent. */
  format?: TextFormat;
  /** Shown above the editor, e.g. what the PDF extractor dropped. */
  notes?: string[];
}

interface Props {
  draft: ImportDraft;
  targetWpm: number;
  onCancel: () => void;
  onSave: (doc: { title: string; text: string; words: number; source: DocSource; origin?: string; format?: DocFormat | null }) => void;
  busy?: boolean;
}

/** The preview draws at most this many words; the counts below it cover everything. */
const PREVIEW_WORDS = 4000;

/**
 * Every import ends here: the text in an editor so junk (headers, references,
 * captions) can be trimmed before reading. Plain text separates paragraphs
 * with line breaks; Markdown keeps bold, italics, headings, lists and links
 * for the text views. Rich text pasted from a web page or a word processor
 * is turned into Markdown as it is pasted.
 */
export function ImportPreview({ draft, targetWpm, onCancel, onSave, busy }: Props) {
  const [title, setTitle] = useState(draft.title);
  const [text, setText] = useState(draft.text);
  const [format, setFormat] = useState<TextFormat>(() => draft.format ?? (looksLikeMarkdown(draft.text) ? 'markdown' : 'plain'));
  /** Once the reader picks a format by hand, pasting no longer changes it. */
  const chosen = useRef(Boolean(draft.format));
  const [preview, setPreview] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const deferredText = useDeferredValue(text);
  const deferredFormat = useDeferredValue(format);
  const converted = useMemo(() => {
    const doc = convertText(deferredText, deferredFormat);
    const words = segment(doc.text);
    const paragraphs = words.length ? words[words.length - 1].paragraphIndex + 1 : 0;
    return { ...doc, words, paragraphs };
  }, [deferredText, deferredFormat]);
  const stale = deferredText !== text || deferredFormat !== format;
  const empty = !text.trim();

  const insert = (value: string) => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    // insertText keeps the browser's undo history; fall back to splicing the value.
    if (!document.execCommand?.('insertText', false, value)) {
      const { selectionStart: a, selectionEnd: b } = el;
      setText(el.value.slice(0, a) + value + el.value.slice(b));
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const plain = e.clipboardData.getData('text/plain');
    const html = e.clipboardData.getData('text/html');
    const keepPlain = chosen.current && format === 'plain';
    // Markdown source copied from an editor is kept as written, even if the editor also offered HTML.
    if (plain && looksLikeMarkdown(plain)) {
      if (!chosen.current) setFormat('markdown');
      return;
    }
    if (keepPlain || !html || !htmlHasFormatting(html)) return;
    const md = htmlStringToMarkdown(html);
    if (!md.trim()) return;
    e.preventDefault();
    if (!chosen.current) setFormat('markdown');
    insert(md);
  };

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
      <div className="row spread import-tools">
        <div className="format-field">
          <span className="label" id="format-label">
            Format
          </span>
          <div className="segmented" role="group" aria-labelledby="format-label">
            {(
              [
                ['plain', 'Plain text'],
                ['markdown', 'Markdown'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                className={format === value ? 'on' : undefined}
                aria-pressed={format === value}
                onClick={() => {
                  chosen.current = true;
                  setFormat(value);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="segmented" role="group" aria-label="Editor view">
          <button className={preview ? undefined : 'on'} aria-pressed={!preview} onClick={() => setPreview(false)}>
            Edit
          </button>
          <button className={preview ? 'on' : undefined} aria-pressed={preview} onClick={() => setPreview(true)} disabled={empty}>
            Preview
          </button>
        </div>
      </div>
      {preview && !empty ? (
        <FormattedPreview words={converted.words} format={converted.format} />
      ) : (
        <textarea
          ref={editorRef}
          className="paste tall"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          placeholder={
            format === 'markdown'
              ? 'Paste or type Markdown here. Formatted text from a web page or a word processor is converted as you paste it.'
              : 'Paste or type text here. Leave a blank line between paragraphs. Formatted text from a web page or a word processor is converted to Markdown as you paste it.'
          }
          autoFocus={!draft.text}
          spellCheck={false}
        />
      )}
      <div className="row spread">
        <span className={`field-hint${stale ? ' stale' : ''}`}>
          {formatCount(converted.words.length)} words · {formatCount(converted.paragraphs)} paragraphs · about{' '}
          {formatDuration((converted.words.length / targetWpm) * 60000)} at {targetWpm} wpm
        </span>
        <button
          className="btn primary"
          disabled={empty || busy}
          onClick={() => {
            const doc = convertText(text, format);
            const words = segment(doc.text).length;
            if (!words) return;
            onSave({ title: title.trim() || 'Untitled', text: doc.text, words, source: draft.source, origin: draft.origin, format: doc.format });
          }}
        >
          Save and read
        </button>
      </div>
    </div>
  );
}

/** The converted text as the reader's text view will show it. */
function FormattedPreview({ words, format }: { words: ReturnType<typeof segment>; format: DocFormat | null }) {
  const styles = useMemo(() => WordStyles.from(format, words), [format, words]);
  const shown = Math.min(words.length, PREVIEW_WORDS);
  const paragraphs: ReactNode[] = [];
  let spans: ReactNode[] = [];
  for (let i = 0; i < shown; i++) {
    const w = words[i];
    if (spans.length && !w.glued) spans.push(' ');
    const cls = wordClass(styles, i).trim();
    spans.push(
      <span key={i} className={cls || undefined} title={styles?.href(i)}>
        {w.text}
      </span>,
    );
    if (w.paragraphEnd || i === shown - 1) {
      const para = paraProps(styles, w.paragraphIndex);
      paragraphs.push(
        <p key={w.paragraphIndex} className={('ctx-para active' + para.className).trim()} style={para.style as CSSProperties | undefined}>
          {spans}
        </p>,
      );
      spans = [];
    }
  }
  return (
    <div className="paste tall formatted-preview" aria-label="Preview">
      {paragraphs}
      {shown < words.length && <p className="ctx-more">… {formatCount(words.length - shown)} more words</p>}
    </div>
  );
}
