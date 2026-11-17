import { useEffect, useRef, type ReactNode } from 'react';

/** A side drawer over the page. Escape closes it (the reader routes Escape here while open). */
export function Panel({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => previous?.focus?.();
  }, []);
  return (
    <div className="panel-backdrop" onClick={onClose}>
      <div
        className={wide ? 'panel wide' : 'panel'}
        role="dialog"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="panel-head">
          <h2>{title}</h2>
          <button className="btn ghost square" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="panel-body">{children}</div>
      </div>
    </div>
  );
}
