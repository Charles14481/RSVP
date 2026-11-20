import { useEffect, useRef, useState } from 'react';
import { fetchArticle, proxyEndpoint, UrlImportError, type Article } from '../ingest/url';

interface Props {
  onArticle: (article: Article) => void;
  onPaste: () => void;
  onClose: () => void;
}

/** Fetch an article by URL through the proxy, or explain why it cannot and offer pasting. */
export function UrlImport({ onArticle, onPaste, onClose }: Props) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(proxyEndpoint() ? null : 'Fetching web pages needs the small fetch proxy, and none is configured for this deployment.');
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const available = proxyEndpoint() != null;

  const submit = async () => {
    if (!url.trim() || busy) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true);
    setError(null);
    try {
      onArticle(await fetchArticle(url, ctrl.signal));
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setError(e instanceof UrlImportError ? e.message : `Something went wrong: ${String(e)}`);
    } finally {
      if (abort.current === ctrl) setBusy(false);
    }
  };

  return (
    <form
      className="url-import"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="row">
        <input
          type="url"
          inputMode="url"
          placeholder="https://example.com/article"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={!available || busy}
          autoFocus
          aria-label="Web page address"
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
        />
        <button className="btn primary" type="submit" disabled={!available || busy || !url.trim()}>
          {busy ? 'Fetching…' : 'Fetch'}
        </button>
        <button className="btn ghost" type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
      {error ? (
        <p className="url-error" role="alert">
          {error}{' '}
          <button type="button" className="link" onClick={onPaste}>
            Paste the text instead
          </button>
          .
        </p>
      ) : (
        <p className="field-hint">The page is fetched through a small proxy and turned into text, keeping headings, emphasis and links; you can edit it before reading.</p>
      )}
    </form>
  );
}
