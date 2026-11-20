// Browser check for formatted imports: pastes Markdown and rich HTML through
// the real clipboard, previews them, saves, and checks the reader's text view
// draws bold, headings, lists and links, and that Ctrl+click opens a link.
// No model is needed: the text view works while paused.
//
//   npm run build && node scripts/smoke-format.mjs [--headed] [--shots <dir>]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const args = process.argv.slice(2);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const shot = async (page, name) => shots && page.screenshot({ path: join(shots, `${name}.png`), fullPage: false });

const port = 4181;
const base = `http://localhost:${port}/`;
const server = await preview({ preview: { port, strictPort: true }, logLevel: 'warn' });
const ctx = await chromium.launchPersistentContext('.cache/smoke-format-profile', {
  channel: 'chrome',
  headless: !args.includes('--headed'),
  viewport: { width: 1100, height: 800 },
});
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });

let failed = false;
const check = (cond, msg) => {
  if (!cond) {
    failed = true;
    console.error('FAIL:', msg);
  }
};

const MARKDOWN = `# Induction heads

__Induction Heads/Circuits ... First described in [A Mathematical Framework](https://transformer-circuits.pub/2021/framework/index.html) and enough of a big deal that we then wrote [an entire other paper on them](https://transformer-circuits.pub/2022/in-context-learning-and-induction-heads/index.html).__
    The **induction behaviour/task**:

- first point
- second point with \`code\`
`;

const RICH = `<meta charset="utf-8"><b style="font-weight:normal" id="docs-internal-guid-x"><h2>From a document</h2>
<p><span style="font-weight:400">Plain words and </span><span style="font-weight:700">heavy words</span><span> with </span><a href="https://example.com/"><span>a link</span></a>.</p>
<ol><li>Numbered item</li></ol></b>`;

async function paste(page, items) {
  await page.evaluate(async (data) => {
    const parts = {};
    for (const [type, value] of Object.entries(data)) parts[type] = new Blob([value], { type });
    await navigator.clipboard.write([new ClipboardItem(parts)]);
  }, items);
  await page.locator('textarea.paste').focus();
  await page.keyboard.press('Control+V');
}

try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('pageerror', (e) => check(false, `page error: ${e.message}`));
  await page.goto(base);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.deleteDatabase('surprisal-reader');
        r.onsuccess = r.onerror = r.onblocked = () => resolve(null);
      }),
  );
  await page.reload();
  await page.locator('.doc-title').first().waitFor();

  console.log('1. paste Markdown source');
  await page.getByRole('button', { name: 'Paste text' }).click();
  await paste(page, { 'text/plain': MARKDOWN });
  const value = await page.locator('textarea.paste').inputValue();
  check(value.includes('[A Mathematical Framework]('), 'Markdown source was not pasted as written');
  check((await page.locator('.format-field button.on').textContent()) === 'Markdown', 'format did not switch to Markdown');
  await page.getByRole('button', { name: 'Preview' }).click();
  await page.locator('.formatted-preview').waitFor();
  const previewText = await page.locator('.formatted-preview').innerText();
  console.log('  preview starts:', JSON.stringify(previewText.slice(0, 90)));
  check(!/\]\(|__|\*\*/.test(previewText), 'preview still shows Markdown syntax');
  check((await page.locator('.formatted-preview .f-h1').count()) === 1, 'no heading in preview');
  check((await page.locator('.formatted-preview .fl').count()) > 0, 'no links in preview');
  await shot(page, '1-markdown-preview');

  console.log('2. save and read');
  await page.locator('.title-field input').fill('Formatting check');
  await page.getByRole('button', { name: 'Save and read' }).click();
  await page.locator('.context .ctx-word').first().waitFor();
  const counts = await page.evaluate(() => ({
    bold: document.querySelectorAll('.context .ctx-word.fb').length,
    code: document.querySelectorAll('.context .ctx-word.fc').length,
    links: document.querySelectorAll('.context .ctx-word.fl').length,
    h1: document.querySelectorAll('.context .ctx-para.f-h1').length,
    li: document.querySelectorAll('.context .ctx-para.f-li').length,
  }));
  console.log('  text view:', counts);
  check(counts.bold > 20 && counts.code === 1 && counts.links === 9 && counts.h1 === 1 && counts.li === 2, 'text view formatting is missing');
  await shot(page, '2-reader');

  console.log('3. Ctrl+click opens a link, a plain click jumps');
  const popup = ctx.waitForEvent('page', { timeout: 5000 });
  await page.locator('.context .ctx-word.fl', { hasText: 'Mathematical' }).click({ modifiers: ['Control'] });
  const opened = await popup.catch(() => null);
  const openedUrl = opened ? opened.url() : '';
  console.log('  opened:', openedUrl);
  check(openedUrl.startsWith('https://transformer-circuits.pub/2021/framework/'), 'Ctrl+click did not open the link');
  await opened?.close();
  await page.locator('.context .ctx-word.fl', { hasText: 'Mathematical' }).click();
  check((await page.locator('.ctx-word.current').textContent()) === 'Mathematical', 'a plain click on a link did not jump to it');

  console.log('4. the RSVP word shows emphasis');
  check(await page.locator('.rsvp-word.fb').count() === 1, 'the flashed bold word is not bold');

  console.log('5. formatting survives a reload');
  await page.reload();
  await page.locator('.doc-title', { hasText: 'Formatting check' }).click();
  await page.locator('.context .ctx-word').first().waitFor();
  check((await page.locator('.context .ctx-word.fl').count()) === 9, 'links lost after reload');

  console.log('6. paste rich text from a document');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Paste text' }).click();
  await paste(page, { 'text/html': RICH, 'text/plain': 'From a document\nPlain words and heavy words with a link.\nNumbered item' });
  const md = await page.locator('textarea.paste').inputValue();
  console.log('  converted:', JSON.stringify(md));
  check(md.includes('## From a document') && md.includes('**heavy words**') && md.includes('[a link](<https://example.com/>)') && md.includes('1. Numbered item'), 'rich paste was not converted to Markdown');
  check(!md.includes('**Plain'), 'normal-weight text was made bold');
  await page.keyboard.press('Control+Z');
  check((await page.locator('textarea.paste').inputValue()) === '', 'undo did not remove the converted paste');
  await page.keyboard.press('Control+Y');
  await page.getByRole('button', { name: 'Preview' }).click();
  await shot(page, '3-rich-preview');
} finally {
  await ctx.close();
  await new Promise((r) => server.httpServer.close(r));
}
console.log(failed ? 'FORMAT SMOKE TEST FAILED' : 'format smoke test passed');
process.exit(failed ? 1 : 0);
