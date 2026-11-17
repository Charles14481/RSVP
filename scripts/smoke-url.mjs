// URL import check in a real browser through the preview server's /api/fetch.
//
//   node scripts/smoke-url.mjs [url]
//
// Builds dist/ with VITE_FETCH_PROXY_URL=/api/fetch (set here, so shells that
// rewrite paths in environment variables cannot mangle it), then fetches a
// public article (network access needed) and checks that the proxy refuses a
// loopback target and a foreign origin.
import { chromium } from 'playwright-core';
import { build, preview } from 'vite';

const target = process.argv[2] ?? 'https://en.wikipedia.org/wiki/Rapid_serial_visual_presentation';
const port = 4181;
process.env.VITE_FETCH_PROXY_URL = '/api/fetch';
await build({ logLevel: 'warn' });
const server = await preview({ preview: { port, strictPort: true }, logLevel: 'warn' });
const ctx = await chromium.launchPersistentContext('.cache/smoke-profile', { channel: 'chrome', headless: true });
let failed = false;
const fail = (m) => {
  failed = true;
  console.error('FAIL:', m);
};

try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('pageerror', (e) => fail(`page error: ${e.message}`));
  page.on('requestfailed', (r) => console.log(`request failed: ${r.url().slice(0, 100)}: ${r.failure()?.errorText}`));
  await page.goto(`http://localhost:${port}/`);

  const refused = await page.evaluate(async () => {
    const r = await fetch(`/api/fetch?url=${encodeURIComponent('http://127.0.0.1/')}`);
    return { status: r.status, body: await r.text() };
  });
  console.log(`loopback target: ${refused.status} ${refused.body}`);
  if (refused.status !== 403) fail('proxy did not refuse a loopback target');

  const foreign = await fetch(`http://localhost:${port}/api/fetch?url=${encodeURIComponent(target)}`, { headers: { Origin: 'https://evil.example' } });
  console.log(`foreign origin: ${foreign.status}`);
  if (foreign.status !== 403) fail('proxy did not refuse a foreign origin');

  await page.getByText('From a web page').click();
  await page.locator('.url-import input').fill(target);
  const t = Date.now();
  await page.getByRole('button', { name: 'Fetch' }).click();
  await Promise.race([
    page.locator('.import textarea').waitFor({ timeout: 30000 }),
    page.locator('.url-error').waitFor({ timeout: 30000 }).then(async () => fail(`url import error: ${await page.locator('.url-error').textContent()}`)),
  ]);
  if (!failed) {
    const title = await page.locator('.title-field input').inputValue();
    const text = await page.locator('.import textarea').inputValue();
    const paragraphs = text.split('\n\n');
    console.log(`fetched in ${Date.now() - t} ms: "${title}", ${paragraphs.length} paragraphs, ${text.split(/\s+/).length} words`);
    console.log(`first paragraph: ${paragraphs[0].slice(0, 160)}…`);
    if (paragraphs.length < 5) fail('too few paragraphs');
    if (/<\w+[^>]*>/.test(text)) fail('HTML tags leaked into the text');
  }
} finally {
  await ctx.close();
  await new Promise((r) => server.httpServer.close(r));
}
console.log(failed ? 'URL SMOKE TEST FAILED' : 'url smoke test passed');
process.exit(failed ? 1 : 0);
