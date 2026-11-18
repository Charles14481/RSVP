import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings';
import {
  addDoc,
  clearSurprisalCache,
  deleteDoc,
  getDoc,
  listDocs,
  loadSettings,
  loadSurprisal,
  resetStoreForTests,
  savePosition,
  saveSettings,
  saveSurprisal,
  seedLibrary,
  sha256Hex,
  updateDoc,
} from './db';

beforeEach(async () => {
  // A fresh in-memory IndexedDB for every test.
  const { IDBFactory } = await import('fake-indexeddb');
  globalThis.indexedDB = new IDBFactory();
  resetStoreForTests();
});

describe('store', () => {
  it('adds, lists and reads documents', async () => {
    const a = await addDoc({ title: ' First ', text: 'One two.', words: 2, source: 'paste' });
    await new Promise((r) => setTimeout(r, 2));
    const b = await addDoc({ title: '', text: 'Three.', words: 1, source: 'file', origin: 'three.txt' });
    expect(a.title).toBe('First');
    expect(b.title).toBe('Untitled');
    expect(a.hash).toBe(await sha256Hex('One two.'));

    const list = await listDocs();
    expect(list.map((d) => d.id)).toEqual([b.id, a.id]);
    expect(list[0]).toMatchObject({ origin: 'three.txt', position: 0, words: 1 });

    const doc = await getDoc(a.id);
    expect(doc).toMatchObject({ text: 'One two.', position: 0, meta: { id: a.id } });
    expect(await getDoc('missing')).toBeNull();
  });

  it('seeds the default documents once, top first, and never brings them back', async () => {
    const defaults = [
      { title: 'Guide', text: 'Read me.', words: 2, source: 'guide' as const },
      { title: 'Sample', text: 'Me too.', words: 2, source: 'sample' as const },
    ];
    const [first, second] = await Promise.all([seedLibrary(defaults), seedLibrary(defaults)]);
    expect(first + second).toBe(2);
    expect((await listDocs()).map((d) => d.title)).toEqual(['Guide', 'Sample']);

    const guide = (await listDocs())[0];
    await deleteDoc(guide.id);
    expect(await seedLibrary(defaults)).toBe(0);
    expect((await listDocs()).map((d) => d.title)).toEqual(['Sample']);
  });

  it('skips a default that an existing library already has', async () => {
    await addDoc({ title: 'Old sample', text: 'Me too.', words: 2, source: 'sample' });
    expect(await seedLibrary([{ title: 'Guide', text: 'Read me.', words: 2, source: 'guide' }, { title: 'Sample', text: 'Me too.', words: 2, source: 'sample' }])).toBe(1);
    expect((await listDocs()).map((d) => d.source).sort()).toEqual(['guide', 'sample']);
  });

  it('persists positions and metadata updates', async () => {
    const a = await addDoc({ title: 'A', text: 'x', words: 1, source: 'paste' });
    await savePosition(a.id, 42);
    await updateDoc(a.id, { title: 'Renamed', openedAt: 1e13 });
    expect((await getDoc(a.id))!.position).toBe(42);
    const [entry] = await listDocs();
    expect(entry).toMatchObject({ title: 'Renamed', position: 42, openedAt: 1e13 });
  });

  it('round-trips settings and fills in new fields', async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
    await saveSettings({ ...DEFAULT_SETTINGS, fontSize: 60, timing: { ...DEFAULT_SETTINGS.timing, targetWpm: 450 } });
    const loaded = await loadSettings();
    expect(loaded.fontSize).toBe(60);
    expect(loaded.timing.targetWpm).toBe(450);
    expect(loaded.timing.spillover).toBe(DEFAULT_SETTINGS.timing.spillover);
  });

  it('caches surprisal per document hash and model, including partial results', async () => {
    const bits = Float32Array.from([1, NaN, 3]);
    await saveSurprisal('h1', 'Xenova/gpt2', bits);
    bits[1] = 99; // the stored copy is independent
    const loaded = await loadSurprisal('h1', 'Xenova/gpt2', 3);
    expect(loaded).toBeInstanceOf(Float32Array);
    expect(Array.from(loaded!)).toEqual([1, NaN, 3]);
    expect(await loadSurprisal('h1', 'Xenova/distilgpt2', 3)).toBeNull();
    expect(await loadSurprisal('h1', 'Xenova/gpt2', 4)).toBeNull(); // wrong length: stale
    expect(await clearSurprisalCache()).toBe(1);
    expect(await loadSurprisal('h1', 'Xenova/gpt2', 3)).toBeNull();
  });

  it('deletes a document with its caches, but keeps caches shared with a duplicate', async () => {
    const a = await addDoc({ title: 'A', text: 'same text', words: 2, source: 'paste' });
    const b = await addDoc({ title: 'B', text: 'same text', words: 2, source: 'paste' });
    const c = await addDoc({ title: 'C', text: 'other', words: 1, source: 'paste' });
    await saveSurprisal(a.hash, 'm', Float32Array.from([1, 2]));
    await saveSurprisal(c.hash, 'm', Float32Array.from([1]));

    await deleteDoc(a.id);
    expect(await getDoc(a.id)).toBeNull();
    expect(await loadSurprisal(a.hash, 'm', 2)).not.toBeNull(); // still used by B

    await deleteDoc(b.id);
    expect(await loadSurprisal(a.hash, 'm', 2)).toBeNull();

    await deleteDoc(c.id);
    expect(await loadSurprisal(c.hash, 'm', 1)).toBeNull();
    expect(await listDocs()).toEqual([]);
  });
});
