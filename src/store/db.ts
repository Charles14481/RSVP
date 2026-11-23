import { createStore, del, delMany, get, getMany, keys, set, setMany, update, type UseStore } from 'idb-keyval';
import { mergeSettings, type Settings } from '../settings';
import type { DocFormat } from '../types';

/**
 * Everything persists in one IndexedDB object store through idb-keyval:
 *
 *   library              DocMeta[]          small; read on every library view
 *   text:<id>            string             the normalized document text
 *   format:<id>          DocFormat          formatting kept from Markdown or HTML (optional)
 *   pos:<id>             number             reading position (word index)
 *   settings             Settings
 *   seeded               true               the default documents have been added
 *   surprisal:<hash>:<model>  Float32Array  per-word bits, NaN = not scored yet
 *
 * Positions live apart from the library so the frequent position writes do
 * not rewrite the whole list.
 */

export type DocSource = 'paste' | 'file' | 'pdf' | 'url' | 'sample' | 'guide';

export interface DocMeta {
  id: string;
  title: string;
  /** SHA-256 of the normalized text; keys the surprisal cache. */
  hash: string;
  words: number;
  source: DocSource;
  /** File name or URL the text came from. */
  origin?: string;
  createdAt: number;
  openedAt: number;
}

export interface LibraryEntry extends DocMeta {
  position: number;
}

let store: UseStore | null = null;

function db(): UseStore {
  return (store ??= createStore('surprisal-reader', 'kv'));
}

/** For tests: start from a fresh database. */
export function resetStoreForTests(): void {
  store = null;
}

const LIBRARY = 'library';
const SETTINGS = 'settings';
const SEEDED = 'seeded';
const textKey = (id: string) => `text:${id}`;
const formatKey = (id: string) => `format:${id}`;
const posKey = (id: string) => `pos:${id}`;
const surprisalKey = (hash: string, modelId: string) => `surprisal:${hash}:${modelId}`;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function newId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Library entries, most recently opened first. */
export async function listDocs(): Promise<LibraryEntry[]> {
  const metas = (await get<DocMeta[]>(LIBRARY, db())) ?? [];
  const positions = await getMany<number | undefined>(metas.map((m) => posKey(m.id)), db());
  return metas
    .map((m, i) => ({ ...m, position: positions[i] ?? 0 }))
    .sort((a, b) => b.openedAt - a.openedAt);
}

export interface NewDoc {
  title: string;
  text: string;
  words: number;
  source: DocSource;
  origin?: string;
  /** Formatting for the text views; the words come from `text` alone. */
  format?: DocFormat | null;
  /** Defaults to now; sets where the document sorts in the library. */
  openedAt?: number;
}

export async function addDoc(input: NewDoc): Promise<DocMeta> {
  const now = input.openedAt ?? Date.now();
  const meta: DocMeta = {
    id: newId(),
    title: input.title.trim() || 'Untitled',
    hash: await sha256Hex(input.text),
    words: input.words,
    source: input.source,
    ...(input.origin ? { origin: input.origin } : {}),
    createdAt: now,
    openedAt: now,
  };
  await setMany(
    [
      [textKey(meta.id), input.text],
      [posKey(meta.id), 0],
      ...(input.format ? ([[formatKey(meta.id), input.format]] as [string, DocFormat][]) : []),
    ],
    db(),
  );
  await update<DocMeta[]>(LIBRARY, (list) => [...(list ?? []), meta], db());
  return meta;
}

/**
 * Add the default documents the first time the library is opened, in the
 * given order, the first sorting at the top. This happens once per database:
 * claiming the flag is a single transaction, so two tabs (or a re-run effect)
 * cannot both add them, and a deleted default stays deleted. A default whose
 * source is already in the library is skipped.
 */
export async function seedLibrary(docs: readonly Omit<NewDoc, 'openedAt'>[]): Promise<number> {
  let claimed = false;
  await update<boolean>(
    SEEDED,
    (done) => {
      claimed = !done;
      return true;
    },
    db(),
  );
  if (!claimed) return 0;
  const present = new Set(((await get<DocMeta[]>(LIBRARY, db())) ?? []).map((m) => m.source));
  const now = Date.now();
  let added = 0;
  for (let i = 0; i < docs.length; i++) {
    if (present.has(docs[i].source)) continue;
    await addDoc({ ...docs[i], openedAt: now - i });
    added++;
  }
  return added;
}

export async function getDoc(id: string): Promise<{ meta: DocMeta; text: string; position: number; format: DocFormat | null } | null> {
  const list = (await get<DocMeta[]>(LIBRARY, db())) ?? [];
  const meta = list.find((m) => m.id === id);
  if (!meta) return null;
  const [text, position, format] = await getMany<unknown>([textKey(id), posKey(id), formatKey(id)], db());
  if (typeof text !== 'string') return null;
  return {
    meta,
    text,
    position: typeof position === 'number' ? position : 0,
    format: format && typeof format === 'object' ? (format as DocFormat) : null,
  };
}

export async function updateDoc(id: string, patch: Partial<Pick<DocMeta, 'title' | 'openedAt'>>): Promise<void> {
  await update<DocMeta[]>(LIBRARY, (list) => (list ?? []).map((m) => (m.id === id ? { ...m, ...patch } : m)), db());
}

export async function savePosition(id: string, index: number): Promise<void> {
  await set(posKey(id), index, db());
}

export async function loadPosition(id: string): Promise<number> {
  const value = await get<number>(posKey(id), db());
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Delete a document, and its surprisal caches unless another document has the same text. */
export async function deleteDoc(id: string): Promise<void> {
  let removed: DocMeta | undefined;
  let remaining: DocMeta[] = [];
  await update<DocMeta[]>(
    LIBRARY,
    (list) => {
      removed = (list ?? []).find((m) => m.id === id);
      remaining = (list ?? []).filter((m) => m.id !== id);
      return remaining;
    },
    db(),
  );
  const doomed = [textKey(id), posKey(id), formatKey(id)];
  if (removed && !remaining.some((m) => m.hash === removed!.hash)) {
    const prefix = `surprisal:${removed.hash}:`;
    for (const k of await keys(db())) if (typeof k === 'string' && k.startsWith(prefix)) doomed.push(k);
  }
  await delMany(doomed, db());
}

export async function loadSettings(): Promise<Settings> {
  return mergeSettings(await get(SETTINGS, db()));
}

export async function saveSettings(settings: Settings): Promise<void> {
  await set(SETTINGS, settings, db());
}

export async function loadSurprisal(hash: string, modelId: string, wordCount: number): Promise<Float32Array | null> {
  const value = await get<Float32Array>(surprisalKey(hash, modelId), db());
  return value instanceof Float32Array && value.length === wordCount ? value : null;
}

export async function saveSurprisal(hash: string, modelId: string, bits: Float32Array): Promise<void> {
  await set(surprisalKey(hash, modelId), bits.slice(), db());
}

/** Remove every cached surprisal array (settings: "clear surprisal cache"). */
export async function clearSurprisalCache(): Promise<number> {
  const doomed = (await keys(db())).filter((k) => typeof k === 'string' && k.startsWith('surprisal:'));
  await delMany(doomed, db());
  return doomed.length;
}

export async function deleteSurprisal(hash: string, modelId: string): Promise<void> {
  await del(surprisalKey(hash, modelId), db());
}
