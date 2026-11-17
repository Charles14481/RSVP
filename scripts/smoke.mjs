// End-to-end smoke test in a real browser: builds nothing, serves dist/ with
// `vite preview`, opens the sample in headless Chrome, waits for the model,
// plays for a few seconds and reports onset timing.
//
//   npm run build && node scripts/smoke.mjs [--wasm] [--headed] [--shots <dir>]
//
// Uses the installed Chrome (playwright-core downloads no browsers). The
// profile lives in .cache/ so the model download is cached between runs.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });

const port = 4179;
const server = await preview({ preview: { port, strictPort: true }, logLevel: 'warn' });
const ctx = await chromium.launchPersistentContext('.cache/smoke-profile', {
  channel: 'chrome',
  headless: !flag('--headed'),
  viewport: { width: 1100, height: 760 },
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--disable-background-timer-throttling'],
});

let failed = false;
const fail = (msg) => {
  failed = true;
  console.error('FAIL:', msg);
};

try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('pageerror', (e) => fail(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}]`, m.text().slice(0, 300));
  });

  await page.goto(`http://localhost:${port}/${flag('--wasm') ? '?backend=wasm' : ''}`);
  const env = await page.evaluate(async () => ({
    isolated: self.crossOriginIsolated,
    webgpu: 'gpu' in navigator && !!(await navigator.gpu.requestAdapter().catch(() => null)),
    threads: navigator.hardwareConcurrency,
  }));
  console.log('environment', env);
  if (!env.isolated) fail('page is not cross-origin isolated');

  await page.getByText('Try the sample').click();
  const t0 = Date.now();
  let last = '';
  for (;;) {
    const chip = await page.locator('.chip').first().textContent({ timeout: 5000 }).catch(() => '');
    if (chip !== last) {
      console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s status: ${chip}`);
      last = chip ?? '';
    }
    if (/failed/i.test(chip ?? '')) {
      fail(`model status: ${chip} — ${await page.locator('.chip').first().getAttribute('title')}`);
      break;
    }
    if (chip && !/Model|Loading|Scored|No model/.test(chip)) break;
    if (Date.now() - t0 > 15 * 60 * 1000) {
      fail('timed out waiting for scoring');
      break;
    }
    await page.waitForTimeout(500);
  }
  console.log('backend:', await page.locator('.chip').first().getAttribute('title'));
  if (shots) await page.screenshot({ path: join(shots, '1-ready.png') });

  if (!failed) {
    // Play for a while, sampling what is on screen.
    await page.keyboard.press('Space');
    const seen = [];
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      const w = await page.locator('.rsvp-word').textContent();
      if (w && w !== seen[seen.length - 1]) seen.push(w);
      await page.waitForTimeout(20);
    }
    if (shots) await page.screenshot({ path: join(shots, '2-playing.png') });
    const stats = await page.evaluate(() => {
      const s = window.__rsvpOnsets;
      return { count: s.count, meanAbs: s.meanAbs, maxAbs: s.maxAbs };
    });
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    if (shots) await page.screenshot({ path: join(shots, '3-paused.png') });
    const state = await page.locator('.reader').getAttribute('data-state');
    const effective = await page.locator('.rate-effective').textContent();
    console.log(`words seen: ${seen.length}: ${seen.slice(0, 12).join(' ')} …`);
    console.log(`onsets: ${stats.count} words, mean |error| ${stats.meanAbs.toFixed(2)} ms, max ${stats.maxAbs.toFixed(2)} ms`);
    console.log(`after pause: state=${state}, ${effective}`);
    if (seen.length < 15) fail('too few words shown while playing');
    if (stats.meanAbs >= 1000 / 60) fail('mean onset error is not under one frame');
    if (state !== 'paused') fail(`expected paused, got ${state}`);
    if ((await page.locator('.ctx-word.current').count()) !== 1) fail('context view does not mark the current word');
  }
} finally {
  await ctx.close();
  await new Promise((r) => server.httpServer.close(r));
}
console.log(failed ? 'SMOKE TEST FAILED' : 'smoke test passed');
process.exit(failed ? 1 : 0);
