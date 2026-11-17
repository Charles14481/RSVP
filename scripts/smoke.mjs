// End-to-end smoke test in a real browser. Serves dist/ with `vite preview`,
// opens the sample in headless Chrome, waits for the model, plays, opens the
// inspector and settings, then reloads to check persistence.
//
//   npm run build && node scripts/smoke.mjs [--wasm] [--headed] [--shots <dir>]
//
// Uses the installed Chrome (playwright-core downloads no browsers). The
// profile lives in .cache/ so the model download is cached between runs; the
// app's own database is wiped at the start of each run.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const shot = async (page, name) => shots && page.screenshot({ path: join(shots, `${name}.png`) });

const port = 4179;
const base = `http://localhost:${port}/${flag('--wasm') ? '?backend=wasm' : ''}`;
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
const check = (cond, msg) => cond || fail(msg);

async function waitForScoring(page) {
  const t0 = Date.now();
  let last = '';
  for (;;) {
    const chip = (await page.locator('.chip').first().textContent({ timeout: 5000 }).catch(() => '')) ?? '';
    if (chip !== last) {
      console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s status: ${chip}`);
      last = chip;
    }
    if (/failed/i.test(chip)) return fail(`model status: ${chip}: ${await page.locator('.chip').first().getAttribute('title')}`);
    if (chip && !/Model|Loading|Scored|No model/.test(chip)) return Date.now() - t0;
    if (Date.now() - t0 > 15 * 60 * 1000) return fail('timed out waiting for scoring');
    await page.waitForTimeout(250);
  }
}

try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('pageerror', (e) => fail(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}]`, m.text().slice(0, 300));
  });

  await page.goto(base);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.deleteDatabase('surprisal-reader');
        r.onsuccess = r.onerror = r.onblocked = () => resolve(null);
      }),
  );
  await page.reload();
  const env = await page.evaluate(async () => ({
    isolated: self.crossOriginIsolated,
    webgpu: 'gpu' in navigator && !!(await navigator.gpu.requestAdapter().catch(() => null)),
  }));
  console.log('environment', env);
  check(env.isolated, 'page is not cross-origin isolated');
  await shot(page, '0-library-empty');

  console.log('1. open the sample from the empty library');
  await page.getByText('read a short introduction').click();
  await waitForScoring(page);
  console.log('  backend:', await page.locator('.chip').first().getAttribute('title'));
  await shot(page, '1-ready');

  if (!failed) {
    console.log('2. play, then pause');
    await page.keyboard.press('Space');
    const seen = [];
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      const w = await page.locator('.rsvp-word').textContent();
      if (w && w !== seen[seen.length - 1]) seen.push(w);
      await page.waitForTimeout(20);
    }
    await shot(page, '2-playing');
    const stats = await page.evaluate(() => {
      const s = window.__rsvpOnsets;
      return { count: s.count, meanAbs: s.meanAbs, maxAbs: s.maxAbs };
    });
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    await shot(page, '3-paused');
    console.log(`  words seen: ${seen.length}: ${seen.slice(0, 10).join(' ')} …`);
    console.log(`  onsets: ${stats.count} words, mean |error| ${stats.meanAbs.toFixed(2)} ms, max ${stats.maxAbs.toFixed(2)} ms`);
    check(seen.length >= 12, 'too few words shown while playing');
    check(stats.meanAbs < 1000 / 60, 'mean onset error is not under one frame');
    check((await page.locator('.reader').getAttribute('data-state')) === 'paused', 'not paused');
    check((await page.locator('.ctx-word.current').count()) === 1, 'context view does not mark the current word');
    const progress = await page.locator('.progress-label').textContent();

    console.log('3. inspector');
    await page.keyboard.press('i');
    await page.locator('.insp-passage').waitFor();
    const shaded = await page.locator('.insp-word[style*="background"]').count();
    await page.locator('.insp-word').nth(5).hover();
    const readout = await page.locator('.insp-readout').textContent();
    console.log(`  ${shaded} shaded words; hover: ${readout}`);
    check(shaded > 50, 'inspector shows too few shaded words');
    check(/bits/.test(readout ?? '') && /ms/.test(readout ?? ''), 'hover readout lacks bits or ms');
    await shot(page, '4-inspector');
    await page.keyboard.press('Escape');
    check((await page.locator('.insp-passage').count()) === 0, 'Escape did not close the inspector');

    console.log('4. settings apply live');
    await page.keyboard.press('s');
    await page.locator('.panel h3', { hasText: 'Pace' }).waitFor();
    const before = await page.locator('.rate-value strong').textContent();
    const slider = page.locator('#s-target-rate');
    await slider.focus();
    for (let k = 0; k < 4; k++) await page.keyboard.press('ArrowRight');
    const after = await page.locator('.rate-value strong').textContent();
    console.log(`  target rate ${before} -> ${after}`);
    check(Number(after) === Number(before) + 100, 'settings change did not apply live');
    await shot(page, '5-settings');
    await page.keyboard.press('Escape');

    console.log('5. reload: cache and position persist');
    await page.waitForTimeout(800); // settings save is debounced
    await page.keyboard.press('Escape'); // back to the library (also saves position)
    await page.locator('.doc-title').first().waitFor();
    const meta = await page.locator('.doc-meta').first().textContent();
    console.log(`  library: ${meta}`);
    check(/% read/.test(meta ?? ''), 'library does not show progress');
    await shot(page, '6-library');
    await page.reload();
    const t0 = Date.now();
    await page.locator('.doc-main').first().click();
    await page.locator('.chip').first().waitFor();
    const ms = await waitForScoring(page);
    const chipTitle = await page.locator('.chip').first().getAttribute('title');
    const progress2 = await page.locator('.progress-label').textContent();
    const wpm2 = await page.locator('.rate-value strong').textContent();
    console.log(`  reopened in ${Date.now() - t0} ms (${ms} ms to scored): ${chipTitle}; ${progress2}; ${wpm2} wpm`);
    check(/from the cache/.test(chipTitle ?? ''), 'surprisal was not restored from the cache');
    check(progress2?.split(' ')[0] === progress?.split(' ')[0], `position not restored (${progress} vs ${progress2})`);
    check(wpm2 === after, 'settings were not persisted');
  }
} finally {
  await ctx.close();
  await new Promise((r) => server.httpServer.close(r));
}
console.log(failed ? 'SMOKE TEST FAILED' : 'smoke test passed');
process.exit(failed ? 1 : 0);
