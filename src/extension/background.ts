import { clearSurprisalCache, loadPosition, loadSurprisal, savePosition, saveSurprisal, sha256Hex } from '../store/db';
import { PORT_NAME, positionId, type Command, type RuntimeRequest } from './protocol';
import { Relay } from './relay';
import { ALL_SITES, loadAll } from './settings';

/**
 * Background page (an MV3 event page). It owns everything that needs the
 * extension's origin: the scoring workers with the language model, and the
 * IndexedDB surprisal cache, so both are shared by every site. Pages reach it
 * over a runtime port; it injects the reader into a tab on demand, which needs
 * only the activeTab permission.
 */

const relay = new Relay({
  createWorker: () => new Worker(new URL('../surprisal/worker.ts', import.meta.url), { type: 'module', name: 'surprisal' }),
  loadCache: async (text, key, words) => {
    const hash = await sha256Hex(text);
    const [bits, position] = await Promise.all([
      loadSurprisal(hash, key, words).catch(() => null),
      loadPosition(positionId(hash)).catch(() => 0),
    ]);
    return { hash, bits, position };
  },
  saveCache: (hash, key, bits) => saveSurprisal(hash, key, bits),
  savePosition: (hash, index) => savePosition(positionId(hash), index),
});

browser.runtime.onConnect.addListener((port) => {
  if (port.name === PORT_NAME) relay.attach(port);
});

browser.runtime.onMessage.addListener((msg: unknown, sender: browser.runtime.MessageSender) => {
  const req = msg as RuntimeRequest | null;
  const tabId = sender.tab?.id;
  switch (req?.type) {
    case 'clear-cache':
      return clearSurprisalCache();
    case 'open-options':
      void browser.runtime.openOptionsPage();
      break;
    case 'reader-opened':
    case 'reader-closed':
      if (tabId !== undefined && !sender.frameId) void markTab(tabId, req.type === 'reader-opened');
      break;
    case 'keep-open':
      return (async () => {
        const granted = await browser.permissions.contains(ALL_SITES);
        // Firefox asks for host access only from a click in an extension page: the options page has the switch.
        if (!granted) await browser.runtime.openOptionsPage();
        return granted;
      })();
  }
  return undefined;
});

/**
 * Tabs whose top frame has a reader open, kept in session storage because
 * this event page can be suspended between page loads.
 */
const OPEN_TABS = 'openReaderTabs';
let tabsUpdate: Promise<unknown> = Promise.resolve();

async function openTabs(): Promise<Set<number>> {
  const stored = (await browser.storage.session.get(OPEN_TABS))[OPEN_TABS];
  return new Set(Array.isArray(stored) ? (stored as number[]) : []);
}

function markTab(tabId: number, open: boolean): Promise<unknown> {
  // One read-modify-write at a time.
  tabsUpdate = tabsUpdate
    .then(async () => {
      const tabs = await openTabs();
      if (open) tabs.add(tabId);
      else tabs.delete(tabId);
      await browser.storage.session.set({ [OPEN_TABS]: [...tabs] });
    })
    .catch(() => {});
  return tabsUpdate;
}

// Keep-open: when a tab that had the reader open finishes loading another page, put the reader back.
browser.tabs.onUpdated.addListener(
  (tabId, info) => {
    if (info.status !== 'complete') return;
    void (async () => {
      if (!(await openTabs()).has(tabId)) return;
      const { ext } = await loadAll();
      if (!ext.keepOpen || !(await browser.permissions.contains(ALL_SITES))) return;
      await run(tabId, { type: 'reopen' }, undefined, true);
    })();
  },
  { properties: ['status'] },
);

browser.tabs.onRemoved.addListener((tabId) => void markTab(tabId, false));

/** Put the reader in the tab (once), then tell it what to do. `quiet`: no "!" badge if the page refuses. */
async function run(tabId: number, cmd: Command, frameId?: number, quiet = false): Promise<void> {
  const target = frameId ? { tabId, frameIds: [frameId] } : { tabId };
  try {
    const [probe] = await browser.scripting.executeScript({
      target,
      func: () => Boolean((window as unknown as { __rsvpReaderExtension?: unknown }).__rsvpReaderExtension),
    });
    if (!probe?.result) {
      await browser.scripting.insertCSS({ target, files: ['highlight.css'] });
      await browser.scripting.executeScript({ target, files: ['content.js'] });
    }
    await browser.tabs.sendMessage(tabId, cmd, frameId ? { frameId } : undefined);
    await browser.action.setBadgeText({ tabId, text: '' });
    await browser.action.setTitle({ tabId, title: null });
  } catch (e) {
    if (quiet) return;
    // Firefox keeps extensions out of some pages (about:, addons.mozilla.org, the PDF viewer, reader view).
    await browser.action.setBadgeText({ tabId, text: '!' }).catch(() => {});
    await browser.action.setBadgeBackgroundColor({ tabId, color: '#c2412d' }).catch(() => {});
    await browser.action
      .setTitle({ tabId, title: `This page can't be read: Firefox doesn't let extensions run here. (${e instanceof Error ? e.message : String(e)})` })
      .catch(() => {});
  }
}

browser.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) void run(tab.id, { type: 'toggle' });
});

browser.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-reader') return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) void run(tab.id, { type: 'toggle' });
});

const MENU = { page: 'rsvp-read-page', from: 'rsvp-read-from', selection: 'rsvp-read-selection' } as const;

async function createMenus(): Promise<void> {
  await browser.menus.removeAll();
  browser.menus.create({ id: MENU.page, title: 'Read this page with RSVP', contexts: ['page'] });
  browser.menus.create({ id: MENU.from, title: 'Read with RSVP from here', contexts: ['page'] });
  browser.menus.create({ id: MENU.selection, title: 'Read selection with RSVP', contexts: ['selection'] });
}

browser.runtime.onInstalled.addListener(() => void createMenus());
browser.runtime.onStartup.addListener(() => void createMenus());

browser.menus.onClicked.addListener((info, tab) => {
  if (tab?.id === undefined) return;
  const frameId = info.frameId || undefined;
  switch (info.menuItemId) {
    case MENU.page:
      void run(tab.id, { type: 'read-page' }, frameId);
      break;
    case MENU.selection:
      void run(tab.id, { type: 'read-selection' }, frameId);
      break;
    case MENU.from:
      if (info.targetElementId !== undefined) void run(tab.id, { type: 'read-from', targetElementId: info.targetElementId }, frameId);
      else void run(tab.id, { type: 'read-page' }, frameId);
      break;
  }
});
