import type { FromWorker, ToWorker } from '../surprisal/protocol';

/** Name of the long-lived port between a page's reader and the background page. */
export const PORT_NAME = 'rsvp-reader';

/** While a reader is open it pings this often, so Firefox does not suspend the background mid-scoring. */
export const PING_MS = 15_000;

/** Content script to background, over the port. */
export type ToBackground =
  | { type: 'worker'; msg: ToWorker }
  /** Cached surprisal and the saved position for this text. */
  | { type: 'cache-load'; reqId: number; text: string; key: string; words: number }
  | { type: 'cache-save'; hash: string; key: string; bits: Float32Array }
  | { type: 'position-save'; hash: string; index: number }
  | { type: 'ping' };

/** Background to content script, over the port. */
export type FromBackground =
  | { type: 'worker'; msg: FromWorker }
  | { type: 'worker-error'; message: string }
  | { type: 'cache'; reqId: number; hash: string; bits: Float32Array | null; position: number };

/** What the background asks an injected content script to do. */
export type Command =
  /** Toolbar button or shortcut: close if open, else read the selection if there is one, else the page. */
  | { type: 'toggle' }
  | { type: 'read-page' }
  | { type: 'read-selection' }
  /** Context menu on an element: read the page from there. */
  | { type: 'read-from'; targetElementId: number }
  /** The tab loaded another page while the reader was open (keep-open setting): open it unless it already is. */
  | { type: 'reopen' };

/** One-off runtime messages to the background (not over the port). */
export type RuntimeRequest =
  | { type: 'clear-cache' }
  | { type: 'open-options' }
  /** A reader opened or was closed in the sending tab's top frame. */
  | { type: 'reader-opened' }
  | { type: 'reader-closed' }
  /** May keep-open be turned on? Answers true if Firefox already allows it, else opens the options page. */
  | { type: 'keep-open' };

/** Surprisal positions are stored per text, under this id. */
export const positionId = (hash: string) => `page:${hash}`;
