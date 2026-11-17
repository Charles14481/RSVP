// Large-PDF check in a real browser: generates a 300-page PDF, imports it
// through the file picker, and measures how soon it plays and whether the UI
// stays responsive while scoring continues in the worker.
//
//   npm run build && node scripts/smoke-pdf.mjs [--pages 300] [--wasm] [--shots <dir>]
//
// Needs Node 22.18+ (imports the TypeScript PDF writer directly).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { preview } from 'vite';
import { flow, makePdf } from '../test/helpers/pdfWriter.ts';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const pages = Number(opt('--pages', 300));
const shots = opt('--shots', null);
if (shots) mkdirSync(shots, { recursive: true });

// Seeded pseudo-prose so no two lines repeat (repeated edge lines look like headers).
let seed = 12345;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const subj = ['the reader', 'a careful listener', 'the old clockmaker', 'our neighbour', 'the committee', 'a young engineer', 'the river', 'each student', 'the city council', 'my grandmother'];
const verb = ['noticed', 'considered', 'remembered', 'explained', 'questioned', 'described', 'ignored', 'admired', 'measured', 'repaired'];
const obj = ['the silent harbour', 'a forgotten letter', 'the winter garden', 'an unusual machine', 'the evening train', 'a narrow staircase', 'the distant mountains', 'every broken promise', 'the market square', 'a curious painting'];
const tail = ['before dawn', 'with great patience', 'for the third time', 'without saying a word', 'in the pale light', 'despite the rain', 'as the bells rang', 'after a long silence', 'near the old bridge', 'in nineteen twelve'];
const sentence = () => {
  const s = `${pick(subj)} ${pick(verb)} ${pick(obj)} ${pick(tail)}${rnd() < 0.3 ? `, and ${pick(subj)} ${pick(verb)} ${pick(obj)}` : ''}.`;
  return s[0].toUpperCase() + s.slice(1);
};
const paragraph = () => Array.from({ length: 3 + Math.floor(rnd() * 5) }, sentence).join(' ');

const specs = [];
for (let p = 1; p <= pages; p++) {
  const runs = [
    { text: 'A Long Generated Book', x: 72, y: 760, size: 9 },
    { text: String(p), x: 300, y: 36, size: 9 },
  ];
  let y = 720;
  while (y > 90) {
    const out = flow([paragraph()], { x: 72, y, chars: 82, indent: 18 });
    const fitting = out.runs.filter((r) => r.y > 70);
    runs.push(...fitting);
    y = out.y - 4;
  }
  specs.push({ runs });
}
mkdirSync('.cache', { recursive: true });
const pdfPath = join('.cache', `generated-${pages}.pdf`);
writeFileSync(pdfPath, makePdf(specs, 'A Long Generated Book'));
console.log(`wrote ${pdfPath}`);

const port = 4180;
const server = await preview({ preview: { port, strictPort: true }, logLevel: 'warn' });
const ctx = await chromium.launchPersistentContext('.cache/smoke-profile', {
  channel: 'chrome',
  headless: !flag('--headed'),
  viewport: { width: 1100, height: 760 },
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--disable-background-timer-throttling'],
});
let failed = false;
const fail = (m) => {
  failed = true;
  console.error('FAIL:', m);
};

try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('pageerror', (e) => fail(`page error: ${e.message}`));
  await page.goto(`http://localhost:${port}/${flag('--wasm') ? '?backend=wasm' : ''}`);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.deleteDatabase('surprisal-reader');
        r.onsuccess = r.onerror = r.onblocked = () => resolve(null);
      }),
  );
  await page.reload();

  let t = Date.now();
  await page.locator('input[type=file]').setInputFiles(pdfPath);
  await page.locator('.import textarea').waitFor({ timeout: 300000 });
  const extractMs = Date.now() - t;
  const notes = await page.locator('.notes li').allTextContents();
  await page.waitForFunction(() => !document.querySelector('.field-hint.stale'), null, { timeout: 60000 });
  const counts = await page.locator('.import .row.spread .field-hint').last().textContent();
  console.log(`extracted ${pages} pages in ${extractMs} ms; ${counts}`);
  console.log(`notes: ${notes.join(' | ')}`);
  if (shots) await page.screenshot({ path: join(shots, 'pdf-1-preview.png') });

  t = Date.now();
  await page.getByText('Save and read').click();
  await page.locator('.reader').waitFor();
  const openMs = Date.now() - t;
  // Press play at once: the reader buffers until the first word is scored, then plays.
  await page.keyboard.press('Space');
  let lastChip = '';
  let readyMs = 0;
  for (;;) {
    const chip = (await page.locator('.chip').first().textContent()) ?? '';
    if (chip !== lastChip) {
      console.log(`  ${Date.now() - t} ms: ${chip}`);
      lastChip = chip;
    }
    if (!readyMs && /Scored/.test(chip)) readyMs = Date.now() - t;
    if ((await page.locator('.reader').getAttribute('data-state')) === 'playing') break;
    if (Date.now() - t > 600000) break;
    await page.waitForTimeout(25);
  }
  const playMs = Date.now() - t;
  console.log(`reader opened in ${openMs} ms; model ready at ${readyMs} ms; playing at ${playMs} ms (${playMs - readyMs} ms after the model was ready)`);
  if (playMs - readyMs > 5000) fail('took more than 5 s after the model was ready to start playing');

  // Responsiveness while the worker keeps scoring: long tasks and frame gaps during playback.
  const perf = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const longTasks = [];
        const obs = new PerformanceObserver((list) => list.getEntries().forEach((e) => longTasks.push(e.duration)));
        try {
          obs.observe({ type: 'longtask', buffered: false });
        } catch {}
        const gaps = [];
        let last = performance.now();
        const end = last + 8000;
        const tick = (now) => {
          gaps.push(now - last);
          last = now;
          if (now < end) requestAnimationFrame(tick);
          else {
            obs.disconnect();
            const s = window.__rsvpOnsets;
            gaps.sort((a, b) => a - b);
            resolve({
              frames: gaps.length,
              p99: gaps[Math.floor(gaps.length * 0.99)],
              maxGap: gaps[gaps.length - 1],
              longTasks: longTasks.length,
              longestTask: Math.max(0, ...longTasks),
              onsetMean: s.meanAbs,
              onsetMax: s.maxAbs,
              onsets: s.count,
              chip: document.querySelector('.chip')?.textContent,
            });
          }
        };
        requestAnimationFrame(tick);
      }),
  );
  console.log(
    `during playback: ${perf.frames} frames, p99 gap ${perf.p99.toFixed(1)} ms, max gap ${perf.maxGap.toFixed(1)} ms, ` +
      `${perf.longTasks} long tasks (longest ${perf.longestTask.toFixed(0)} ms); onsets ${perf.onsets}, mean |error| ${perf.onsetMean.toFixed(2)} ms, max ${perf.onsetMax.toFixed(1)} ms; ${perf.chip}`,
  );
  if (shots) await page.screenshot({ path: join(shots, 'pdf-2-playing.png') });
  if (perf.onsetMean >= 1000 / 60) fail('mean onset error is not under one frame while scoring');
  if (perf.p99 > 50) fail('frame gaps above 50 ms at the 99th percentile while scoring');
} finally {
  await ctx.close();
  await new Promise((r) => server.httpServer.close(r));
}
console.log(failed ? 'PDF SMOKE TEST FAILED' : 'pdf smoke test passed');
process.exit(failed ? 1 : 0);
