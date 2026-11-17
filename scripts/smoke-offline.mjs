// Offline check in a real browser: installs the service worker, reads once
// online (so the model is in the browser cache), then cuts the network,
// reloads, reopens a cached document and scores a newly pasted one.
//
//   npm run build && node scripts/smoke-offline.mjs [--wasm]
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const wasm = process.argv.includes('--wasm');
const port = 4186;
const base = `http://localhost:${port}/${wasm ? '?backend=wasm' : ''}`;
const server = await preview({ preview: { port, strictPort: true }, logLevel: 'warn' });
const ctx = await chromium.launchPersistentContext('.cache/smoke-profile', {
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU'],
});
let failed = false;
const fail = (m) => {
  failed = true;
  console.error('FAIL:', m);
};

async function waitScored(page, label) {
  const t0 = Date.now();
  for (;;) {
    const chip = (await page.locator('.chip').first().textContent().catch(() => '')) ?? '';
    if (/failed/i.test(chip)) return fail(`${label}: ${chip}: ${await page.locator('.chip').first().getAttribute('title')}`);
    if (chip && !/Model|Loading|Scored|No model/.test(chip)) return Date.now() - t0;
    if (Date.now() - t0 > 600000) return fail(`${label}: timed out`);
    await page.waitForTimeout(200);
  }
}

try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('pageerror', (e) => fail(`page error: ${e.message}`));
  await page.goto(base);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.deleteDatabase('surprisal-reader');
        r.onsuccess = r.onerror = r.onblocked = () => resolve(null);
      }),
  );
  await page.reload();
  const sw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return { scope: reg.scope, active: !!reg.active };
  });
  console.log('service worker:', sw);
  const shell = await page.evaluate(async () => {
    const keys = await caches.keys();
    const shellKey = keys.find((k) => k.startsWith('surprisal-reader-shell-'));
    const n = shellKey ? (await (await caches.open(shellKey)).keys()).length : 0;
    return { keys, files: n };
  });
  console.log('caches:', shell);

  await page.getByText('read a short introduction').click();
  console.log(`online: scored in ${await waitScored(page, 'online')} ms`);
  await page.keyboard.press('Escape');
  await page.locator('.doc-title').first().waitFor();

  console.log('going offline');
  await ctx.setOffline(true);
  await page.reload();
  await page.locator('.doc-title').first().waitFor({ timeout: 15000 });
  console.log(`offline reload: library shows "${await page.locator('.doc-title').first().textContent()}", isolated=${await page.evaluate(() => crossOriginIsolated)}`);
  await page.locator('.doc-main').first().click();
  const t = await waitScored(page, 'cached document');
  console.log(`offline: cached document ready in ${t} ms: ${await page.locator('.chip').first().getAttribute('title')}`);
  await page.keyboard.press('Space');
  await page.waitForTimeout(1500);
  const playing = await page.locator('.reader').getAttribute('data-state');
  console.log(`offline: state after play: ${playing}`);
  if (playing !== 'playing') fail('cached document does not play offline');
  await page.keyboard.press('Space');
  await page.keyboard.press('Escape');

  await page.getByText('Paste text').click();
  await page.locator('.import textarea').fill('Nothing here was fetched from the network. The words of this short note are scored by a model that the browser kept from an earlier visit, and the reader paces them as usual.');
  await page.getByText('Save and read').click();
  const t2 = await waitScored(page, 'new document offline');
  console.log(`offline: new document scored in ${t2} ms: ${await page.locator('.chip').first().getAttribute('title')}`);
  await ctx.setOffline(false);
} finally {
  await ctx.close();
  await new Promise((r) => server.httpServer.close(r));
}
console.log(failed ? 'OFFLINE SMOKE TEST FAILED' : 'offline smoke test passed');
process.exit(failed ? 1 : 0);
