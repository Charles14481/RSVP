# Decisions and deviations from the plan

Each entry: what changed, and why.

## Milestone 1

- **Toolchain versions.** Installed versions are Vite 8, React 19, TypeScript 7, Vitest 5,
  Transformers.js 4.3.2. The plan named no versions beyond Transformers.js v4.x.

- **Surprisal is stored as a `Float32Array` parallel to `Word[]`, not as `Word.surprisalBits`.**
  NaN means "not scored yet". Batches of results from the worker can then be written straight
  into it and cached as a single binary blob, without copying or mutating thousands of word
  objects. The `Word` type otherwise matches the plan.

- **Split long chunks carry a `glued` flag.** A chunk longer than 20 characters is split at
  hyphens or slashes for display, but the language model sees the original whitespace-delimited
  chunk. `glued: true` marks the continuation pieces so the alignment step can merge them back
  (`chunksOf`). Each piece of a chunk gets the chunk's surprisal divided evenly, so the total is
  unchanged.

- **Spillover at the last word.** The plan's formula s'_i = (1 - L) s_i + L s_(i-1) loses L * s_last
  over a whole document. The last word keeps its full surprisal, so the sum is preserved exactly
  (the test asserts it). If word i-1 is unscored while word i is scored, word i keeps its own
  surprisal rather than borrowing a NaN.

- **Single newlines.** The plan says "keep paragraph breaks". Blank lines always separate
  paragraphs. A single newline also separates paragraphs, except in text that looks hard-wrapped
  (no line over 100 characters and at least three lines) where the line was nearly full; those
  lines are rejoined. Pasted email or Project Gutenberg text then reads as prose rather than one
  paragraph per line. The import preview lets the user fix anything this gets wrong.

- **Normalization removes invisible characters and control codes** (soft hyphen, zero-width
  space, BOM, C0/C1 controls) in addition to NFKC and whitespace collapsing. They would otherwise
  produce tokens that belong to no visible word and break the alignment invariant.

- **Fixed-rate mode is an explicit setting** (`pacing: 'fixed'`), equivalent to strength A = 0.
  It is never selected automatically: if surprisal is unavailable the player buffers and says
  why, as the plan requires.

- **Pauses use paragraph end over sentence end, not both.** A paragraph's last word gets the
  paragraph pause (2 T) only. Adding both would make 3 T, which is not what the plan's list
  suggests.

- **The scheduler resynchronizes after stalls.** If a word goes up more than 250 ms late (a
  throttled background tab, a long GC pause), the next deadline is measured from now instead of
  the missed deadline, so the reader does not see a burst of words flashed to catch up.

## Milestone 2

- **Model files (checked against the repos on 2026-11-17).** Decoder-only models in
  Transformers.js 4.3 load `onnx/model{suffix}.onnx` unless `model_file_name` overrides it.
  - WebGPU: `model_fp16.onnx` when the adapter has `shader-f16`, else `model.onnx` (fp32).
  - WASM: `decoder_model_merged_quantized.onnx` (q8). It is 128 MB for GPT-2 and 85 MB for
    DistilGPT-2, against 281 MB for GPT-2's `model_int8`/`model_uint8` and 236 MB for
    DistilGPT-2's `model_quantized`. Transformers.js feeds the merged decoder an empty KV cache,
    so a plain forward pass works.
  The table lives in `src/surprisal/models.ts` rather than being discovered at runtime; the
  sizes are needed for the progress bar before any bytes arrive anyway.

- **Quantization error is larger than "slight", and acceptable.** Against PyTorch fp32 (slow
  test), the 8-bit files give per-word correlation 0.96 to 0.99 and a mean absolute difference
  of about 1 bit per word, biased upward by about 0.5 bits. Durations use s / mean_s with a
  running mean, so the bias cancels. fp32 Transformers.js agrees with PyTorch to 1.4e-4 bits per
  token, far inside the plan's 0.01.

- **A warm-up forward pass guards each backend.** After loading, eight tokens go through the
  model. Non-finite logits or an exception moves on to the next option
  (WebGPU fp16, then WebGPU fp32, then WASM q8). The fallback is reported in the status chip's
  tooltip. If every option fails the reader shows the error with explicit choices (retry, CPU
  backend, other model, fixed rate) and never switches to fixed timing by itself.

- **Grouping works on chunks, not display words.** The model sees whitespace-delimited chunks;
  long chunks split for display are merged back (`chunksOf`). The invariant compares groups
  with chunks. A chunk's surprisal is divided evenly across its display pieces, each capped at
  25 bits. The group count is checked on every run; the decode-and-compare text check runs in
  dev builds and in tests, because decoding every group of a long book takes seconds.

- **Paragraph separators are not scored.** Newline tokens belong to no word, so their
  targets are skipped (they are context only).

- **Scoring starts where the reader is.** The window planner takes a cursor: it scores the
  first unscored target at or after it, continues to the end, then wraps to the beginning.
  Seeking into unscored text, or starting to buffer, moves the cursor there. Opening a long
  document at a saved position therefore plays within one window's time instead of after
  scoring everything before it. From the start of a document the windows are exactly the
  plan's: [0, W), then advancing by S with the first W - S tokens as context.

- **Log-softmax only on scored rows.** Only S rows per window are needed; the other W - S rows
  are context, so computing their normalizers would be wasted work.

- **Mean seed.** Measured on the app's sample prose (original text, so not memorized):
  GPT-2 6.45 bits/word fp32, 6.97 q8; DistilGPT-2 7.35 fp32, 7.73 q8. Seeds are 6.7 and 7.5,
  weighted as 50 words of prior. The Austen fixture is unsuitable for this: GPT-2 has
  largely memorized it (5.5 bits/word).

- **Windowing check thresholds.** On the Austen fixture the mean absolute difference at window
  starts against one full-context pass is 0.15 bits (W = 512), 0.41 (W = 256) and 0.53
  (W = 128), with word correlations 0.994, 0.988 and 0.945. The test asserts that differences
  shrink as the window grows and bounds the default W = 512 tightly. Memorized text exaggerates
  the benefit of long context, so the smaller windows get looser bounds.

- **Independent alignment in the reference script.** The Python reference maps tokens to words
  with the fast tokenizer's character offsets, not the token-string rule the app uses. The slow
  test checks that both produce the same words with the same sums.

- **Tokenizer fixtures are vendored** (`test/fixtures/models/Xenova/gpt2`, 2 MB) so the alignment
  tests run offline.

- **Cross-origin isolation.** The dev and preview servers send COOP/COEP so ONNX Runtime can use
  threaded WASM. Deployments need the same headers. Vite bundles ONNX Runtime's WASM binary, so
  nothing is fetched from a CDN at runtime apart from the model.

- **Browser smoke test.** `scripts/smoke.mjs` drives the installed Chrome through
  `playwright-core` (no browser download): it loads the sample, waits for the model, plays and
  checks onset error. On this machine: WebGPU fp16 and WASM q8 both work, with a mean onset
  error of about 1 ms and a maximum of 2 to 3.5 ms.

- **URL overrides** `?backend=wasm` and `?model=<id>` exist for debugging and the smoke test.

## Milestone 3

- **Storage layout.** One IndexedDB object store through idb-keyval: a small `library` list of
  document metadata, `text:<id>`, `pos:<id>`, `settings`, and `surprisal:<sha256>:<model>`.
  Positions are kept apart from the library list because they are written every few seconds
  while reading.

- **The surprisal cache is keyed by (document hash, model id) only**, as planned. Values scored
  on WebGPU fp16 and on WASM q8, or with different windows, share a key; they differ by about a
  bit per word but timing normalizes by the running mean. Partial results are cached too (NaN for
  unscored words) and reused: reopening a half-scored book scores only the rest. The cache is
  written at most every 2 s while scoring, when scoring finishes, and when the reader closes.
  A fully cached document plays without loading the model at all.

- **Deleting a document deletes its caches** unless another library document has identical text.
  Settings has a "Clear surprisal cache" button.

- **The sample is a library document** (source `sample`), so it behaves like any other text.
  A getting-started guide (source `guide`, `src/ui/guide.ts`) joins it. Both are added once per
  database, when the library is first opened. Deleting them is permanent, but the empty library
  links to both. The sample text is unchanged because the mean seed was measured on it.

- **Settings from URL overrides are never saved**, so a debugging link cannot change stored
  preferences. "Reset to defaults" keeps the chosen model and backend.

- **Inspector.** Shows two paragraphs either side of the current word (at most 700 words each
  way), shaded linearly from 0 to 16+ bits. Hover shows surprisal, surprisal after spillover and
  the full duration with its pause share. Clicking a word jumps there. Keyboard: I opens it,
  S opens settings (additions to the plan's shortcuts). (Superseded: see "Reading views" below.)

- **The paste box became the import preview.** Pasting, text files and (next) PDFs and URLs all
  go through the same editable preview with live word count and reading-time estimate.

## Milestone 4

- **PDF layout is a pure module** (`src/ingest/pdfLayout.ts`) fed positioned items by a thin
  pdf.js wrapper, so it is unit-tested on synthetic pages, and the wrapper is tested on real
  PDFs produced by a small writer in `test/helpers/pdfWriter.ts`.

- **Columns.** A page is read as two columns when some vertical band in the middle 30 to 70
  percent of the page, at least 0.8 em wide, is crossed by at most a tenth of the items, and
  both sides have at least a fifth of the items over four or more lines. Items crossing the
  gutter (titles) are read before the columns if above them, after otherwise. Anything subtler
  is left to the preview, as planned.

- **Headers and footers.** Among the top two and bottom two lines of each page, text that recurs
  (digits ignored, so "Page 3" matches "Page 4") on at least half of the pages with text, and on
  at least three pages, is dropped. Bare page numbers (arabic, roman, "Page n of m", "- n -") at
  a page edge are dropped everywhere.

- **Paragraphs.** A new paragraph starts at a vertical gap over 1.45 times the block's median
  line spacing, a first-line indent, a font-size change (headings), or after a line that ends
  20 percent or more short of the column's right edge with terminal punctuation (35 percent
  without). Across a page or column boundary only the indent and short-line rules apply.

- **Hyphenation.** A line ending in letter + hyphen joins the next line without the hyphen when
  the next line starts lowercase ("experi- ment"), and keeps the hyphen without a space when it
  starts with a capital or digit ("Anglo- Saxon", "COVID- 19"). A compound broken at its own
  hyphen ("well- known") loses the hyphen; the preview shows the result.

- **Rotated and vertical text is skipped** (watermarks, sideways margin notes).

- **pdf.js is loaded on demand** with its worker, so it costs nothing until a PDF is opened.
  No `standardFontDataUrl` is configured: text extraction works without the standard font
  files, and pdf.js only logs a warning for PDFs using non-embedded standard fonts.

- **Large-PDF check** (`scripts/smoke-pdf.mjs`): a generated 300-page PDF (148,904 words,
  171k tokens) extracts in about 1 s in Chrome. Playback starts 1.9 s after the model is ready
  on WebGPU and 1.5 s on WASM, about 6 to 7 s after "Save and read" including model start-up.
  While scoring continues there are no long tasks on the main thread, the worst frame gap is
  one frame, and mean onset error stays near 1 ms.

## Milestone 5

- **One handler, two hosts.** `server/fetchProxy.ts` uses only the Fetch API (`Request`,
  `Response`, `fetch`, `AbortSignal.timeout`), so the Vite dev/preview middleware
  (`server/vitePlugin.ts`) and the Cloudflare Worker (`worker/fetch-proxy.ts`, `wrangler.toml`)
  share it unchanged. `vite preview` serves the proxy too, so a production build can be tested
  locally with `VITE_FETCH_PROXY_URL=/api/fetch`.

- **What "reject private and loopback hosts" covers.** IPv4 private, loopback, link-local
  (including cloud metadata 169.254.169.254), CGNAT, benchmark, multicast and reserved ranges;
  IPv6 loopback, unspecified, unique-local, link-local, multicast, and IPv4-mapped/NAT64 forms
  of private IPv4; names such as `localhost`, `*.local`, `*.internal` and single-label hosts.
  Numeric host spellings (`2130706433`, `0x7f.0.0.1`) are normalized by the URL parser and
  caught as IPv4. Every redirect target is re-checked (redirects are followed manually, at most
  five). In Node the hostname's DNS answers are checked as well; a rebinding race between that
  lookup and the fetch's own lookup remains, which is acceptable for a local dev server. Workers
  cannot reach private networks at all.

- **Extra restrictions beyond the plan:** ports other than 80, 443, 8080 and 8443 and URLs with
  embedded credentials are refused, and only HTML, XHTML, XML and plain-text responses are
  passed through (a PDF link gets a clear error).

- **Allowed origins.** The Worker requires an `Origin` in `ALLOWED_ORIGINS`. The dev middleware
  also accepts requests without an `Origin`, because browsers send none on same-origin GETs; it
  binds to localhost by default.

- **The proxy body is inert.** It is served as `text/plain; charset=x-user-defined` with
  `nosniff` and a `sandbox` CSP, so opening a proxy URL directly can never render the fetched
  page on the reader's origin. The upstream content type and final URL travel in
  `X-Upstream-Content-Type` and `X-Final-Url`; the client decodes the bytes itself (header
  charset, then BOM, then `<meta charset>`, then UTF-8).

- **Paragraphs from an article without inserting HTML.** Readability's `textContent` flattens
  paragraphs together, so the article HTML Readability returns is parsed again with DOMParser
  into an inert document (never attached to the page, scripts never run) and read block by block
  through `textContent`. A test asserts that the page's scripts do not run and the live DOM is
  untouched.

- **Title cleanup.** A trailing " | Site Name" is removed when Readability reports the site name.

- **The Node hosts do not use the global `fetch`.** Node's bundled undici can throw an
  uncatchable `assert(!this.paused)` from its HTTP parser when a response body is cancelled while
  the server closes the connection. The proxy cancels bodies on redirects, error statuses and
  non-HTML responses, and the assertion killed the dev server. The Vite middleware therefore
  passes `server/nodeFetch.ts`, a minimal fetch over `node:http`/`node:https`, in which every
  failure is an ordinary error event. The Worker keeps the platform `fetch`.

- **Windows note.** Git Bash rewrites `VITE_FETCH_PROXY_URL=/api/fetch` into a Windows path, so
  `scripts/smoke-url.mjs` sets the variable itself and builds through Vite's API.

## Milestone 6

- **Touch.** Tapping the reader plays and pauses (the plan's "tap to pause", in both directions).
  (Since narrowed: only the word starts playback; see "Reading views" below.)
  Previous- and next-sentence buttons flank Play in the footer, since touch has no arrow keys.
  The hint line reads "Tap…" or "Space…" depending on `(pointer: coarse)`. `touch-action:
  manipulation` stops double-tap zoom from eating taps.

- **Narrow screens (under 640 px).** The back button shrinks to an arrow, the status chip is
  hidden (buffering and problems are still shown in the reader), and the word size is capped at
  12vw so a 44 px setting still fits a phone. Long words shrink to fit either side of the pivot,
  as on desktop.

- **Shortcut list on `?`**, alongside I (inspector) and S (settings). The plan's shortcuts are
  unchanged.

- **Error states, checked in the browser.** If the model fails to load, the reader holds playback
  and offers retry, the other model, the CPU backend, or fixed rate. It never switches by itself.
  Scoring errors keep the words already scored. Alignment errors name the word that failed.
  Storage, PDF (no text layer, password, invalid file) and URL failures appear in the library with
  the way forward (usually: paste the text).

## Milestone 7

- **Boundary-corrected surprisal (flag, off by default).** With B(d) the probability, under
  distribution d, that the next token starts a new word (every token whose text starts with
  whitespace, plus EOS), a word's surprisal becomes
  s(tokens) − log₂ B(after) + log₂ B(before). "Before" is the distribution that predicts the
  word's first token, and is used only when that token carries a leading space; after a newline
  or at the start of the text a new word is certain. "After" is the distribution that predicts
  the token following the word's last token; the document's last word has none and keeps
  B = 1. A newline that follows a paragraph's last word is scored for this purpose even though
  it belongs to no word.
  - Word-initial ids are found by decoding the whole vocabulary once per model in the worker
    (about 0.2 s for GPT-2).
  - Checks: within a paragraph the corrections telescope (unit test with an exact identity), the
    values do not depend on windowing, and they match an independent PyTorch implementation in
    `scripts/reference_surprisal.py` to 1.5e-4 bits. On the fixtures the correction moves words by
    0.2 to 0.4 bits on average.
  - Corrected values are cached under `<model>+boundary`, so toggling the flag does not mix
    plain and corrected scores.

- **PWA and offline.** `tools/swPlugin.ts` writes `sw.js` at build time with every built file
  (including the 26 MB ONNX Runtime WASM and the pdf.js worker) to precache. Navigations are
  network-first, so a new deployment is picked up, and fall back to the cached shell; hashed
  assets are cache-first. The service worker leaves cross-origin requests and `/api/` alone:
  Transformers.js already keeps model files in Cache Storage and reads them before the network,
  so scoring works offline once the model has been downloaded. Matching ignores `Vary`, because
  module scripts carry an `Origin` header that the precache requests lacked; with `Vary: Origin`
  from the server, every script missed the cache offline. Cached responses keep their COOP/COEP
  headers, so the offline app is still cross-origin isolated. The service worker is registered
  in production builds only. The build uses a relative `base` so it works from a subpath.
  Checked by `scripts/smoke-offline.mjs`: offline reload, cached document plays, and a new
  document is scored offline in about 3 s.

## Reading views

- **The text views scroll through the whole document, a window at a time.** The paused text and
  the inspector render about 2,000 words either side of the current word, add 1,500 more when
  scrolling comes within 800 px of an edge, and never hold more than 12,000 (the far side is
  trimmed). Rendering a 150,000-word book as spans on every pause is too slow, which is the reason
  for the window. Edges snap to paragraph breaks unless a paragraph is longer than a chunk. When
  text is added or removed above the viewport, the first word of the topmost visible paragraph is
  put back where it was; `overflow-anchor: none` keeps the browser's own scroll anchoring from
  adjusting twice. The shared logic is `src/ui/useScrollWindow.ts`.
- **Text while playing (setting, off by default).** Classic RSVP shows nothing but the word, so
  this is opt-in. While playing, the text is dimmed and the word on screen is marked by toggling
  a class on one span outside React, once per word, from the scheduler's `show`. The mark only
  changes paint properties, so reading its position afterwards does not force a layout. The view
  scrolls to keep the word between 15% and 60% of its height, and holds off for 3 s after the
  reader scrolls by hand. A seek outside the loaded range recentres the window.
- **Only the word starts playback.** A click anywhere in the reader pauses, but only a click on
  the word (or Space, or Play) starts it, so clicking beside the text to dismiss something or
  focus the page does not set words flashing.
- **Inspector predictions.** Clicking a word in the inspector shows the model's ten most probable
  next tokens just before it, with probabilities, and the rank and probability of the token the
  text actually used. Jumping moved to a "Read from here" button. The worker runs one forward pass
  over the window of tokens before the word's first token (the same window size as scoring) and
  reads the last row. These are tokens, not words: a guess can be punctuation or the first piece
  of a longer word, and the actual word's full surprisal is shown next to them. Predicting
  several-token words would need a short generation per candidate, which is more than the panel
  needs. The worker keeps the last aligned document, so a click does not re-tokenize the text,
  and runs model calls one at a time, so a prediction waits for at most one scoring window. A
  fully cached document loads the model on the first click.
- **Inspector shows the whole text (setting, on by default).** Off restores the earlier view of
  two paragraphs either side.

## Multi-word RSVP

- **Groups of up to 1, 2 or 3 words (setting `wordsPerFlash`, default 1; keys 1 to 3).** A group
  ends after any word that earns a pause (clause, sentence or paragraph end, a lone dash), so a
  phrase never straddles punctuation and the pause still lands after it. It also stops before
  passing 6 + 7n characters (20 for two words, 27 for three) so groups stay readable at the chosen
  word size; a single long word is still shown alone. Glued pieces of a split chunk join without a
  space. `src/player/groups.ts`.
- **Groups are formed greedily from wherever reading starts**, not fixed for the document, so
  clicking a word or resuming at a sentence start always begins a group exactly there. Breaks at
  punctuation make the grouping settle into the same phrases within a clause either way.
- **A group stays up for the sum of its words' durations.** Surprisal still decides the time (a
  phrase holding a surprising word stays up longer), the effective rate and time-left estimate
  are unchanged by the group size, and a group waits (buffering) until every word in it is
  scored. Shorter totals for grouped words, on the theory that phrases are read faster, would be a
  separate pacing claim that the timing model does not make.
- **The pivot is the usual letter of the word under the middle of the phrase.** The pivot column
  stays fixed, so the eye lands near the phrase's centre on a natural fixation letter; for one word
  this is exactly the single-word pivot. Wide phrases shrink to fit like long words.
- **Positions stay word indices.** The scheduler takes an optional `next(i)` from its host
  (default i + 1) and otherwise does not know about groups; progress, saved positions, sentence
  navigation and pausing all see the group's first word. The live text marks every word of the
  group on screen.

## Markdown and rich text

- **One editable form: Markdown.** The import preview stays a plain textarea. Markdown files and
  pasted Markdown are kept as written; rich HTML (a paste from a web page, Word or Google Docs, an
  `.html` file, a fetched article) is converted to Markdown first (`src/ingest/html.ts`), so
  trimming junk works the same everywhere and nothing is hidden from the editor. A Plain text /
  Markdown switch decides how the text is read; it is guessed on paste and on load
  (`looksLikeMarkdown`, which needs a strong sign such as a link, bold, a heading, a fence or a
  table, or two weak ones), and a choice made by hand sticks. Plain text is the default because
  reading prose as Markdown can turn an indented paragraph into code or eat asterisks. Pasted
  text that itself looks like Markdown wins over the HTML an editor puts beside it, since code
  editors copy syntax-highlighted HTML.
- **Stored as plain text plus a formatting layer.** `text:<id>` stays the normalized plain text,
  so the surprisal cache, positions and alignment are unchanged and the model never sees syntax
  or URLs. `format:<id>` (`DocFormat` in `src/types.ts`) holds word-index runs of style bits
  (bold, italic, code, strike), word-index runs of links and per-paragraph block styles
  (heading level, list item with depth, quote, code line, table row). Older documents simply
  have none. Ranges outside the text are ignored, so a bad record can only lose formatting.
- **Conversion goes through normalizeText.** `src/ingest/markdown.ts` walks marked's tokens
  (marked 18.1.3, CommonMark plus GitHub tables, strikethrough and autolinks) and writes the text
  with private-use sentinel characters where styles, links and blocks start and end. That string
  is normalized like any plain-text import, then the sentinels are stripped chunk by chunk and
  become word formatting. Paragraph splitting is therefore identical to plain text, including
  the hard-wrap rule: a single line break inside a Markdown paragraph starts a new paragraph
  unless the document looks hard-wrapped. Strict CommonMark would join such lines; notes and
  pasted snippets (like an indented line under a bold heading) usually mean them as separate.
  Every line of a list item or quote carries the block's sentinel, so lines that become
  paragraphs keep their style. Sentinel code points are removed from the input first.
- **Emphasis with a space inside the delimiters is accepted.** Note apps and word processors
  often export "**Anti-induction heads: **A variant" or "__suppresses __the", which strict
  CommonMark (and GitHub) shows with literal asterisks and underscores. `repairEmphasis` moves
  the space outside the delimiters before parsing, outside fenced code and code spans, and only
  when the pair is unambiguous: "2 ** 3 ** 4", `__init__`, list markers and valid emphasis are
  left alone. The Markdown detector accepts the same form.
- **Word granularity.** A word is styled if any of its characters is, and a link covers every word
  with a linked character (so "them." in "[them](...)." is linked). Drawing per word keeps the
  text views' one-span-per-word structure that live following depends on.
- **What is kept and what is dropped.** Link text is kept and the URL dropped; only http(s) and
  mailto links are stored, others keep their text. Images, rules, link definitions and HTML
  comments are dropped. Code blocks become one paragraph per non-blank line. Table rows become
  paragraphs with cells joined by "; " (no separator after a cell ending in punctuation), so the
  RSVP display never flashes a lone "|". Ordered list numbers stay in the text ("2."); bullets are
  drawn, not read. Simple inline HTML (b, i, em, strong, code, s, a, br) is understood, and any
  left open is closed at the end of its block.
- **Display.** The text views and inspector draw bold, italics, code, strikethrough, links,
  headings, nested lists, quotes and code lines. A plain click still jumps (or asks the model, in
  the inspector); Ctrl/Cmd+click or a middle click opens a link in a new tab with
  `noopener,noreferrer`. The flashed word is set in bold, italics or monospace when every word on
  screen shares that style (headings count as bold), and the display measures with that font so
  the pivot stays put. Formatting never changes timing.
- **Fetched articles keep their formatting.** Readability's article HTML is converted to Markdown
  (`Article.markdown`) as well as plain text; the plain text still decides whether there is
  enough of an article.
- **Rich paste uses `execCommand('insertText')`** so the converted paste can be undone with
  Ctrl+Z like any other edit.
- **Not supported yet:** `.docx`, `.epub` and `.rtf` files (rich text pasted from those apps is
  converted). Each needs its own reader; .docx and .epub also need unzipping.


## Firefox extension

- **The model runs in the background page, and the background only relays.** Content scripts
  cannot start a worker from the extension. An extension iframe placed inside the page could have
  its storage partitioned per site, which would mean a model download for every site. The
  background has the extension's origin, so the model and the surprisal cache are shared by every
  site.
  - `SurprisalService` now takes a worker factory. The content script passes
    `BackgroundConnection`, which looks like a worker but relays messages over a `runtime.Port`.
    The background (`Relay`) forwards them to a real scoring worker. `client.ts`, `protocol.ts`
    and `worker.ts` work as in the app.
  - The app's worker factory moved to `src/surprisal/service.ts`, so the content-script bundle
    does not pull in the worker.
- **One worker per page, then kept warm.** A worker runs one job at a time, so each connected page
  gets its own.
  - When a page closes, its job is cancelled and the worker is kept for 5 minutes, model loaded,
    for the next page.
  - A kept worker asked to load the model it already has now announces `ready` again. Before
    this, a second page would have shown "loading" indefinitely.
- **Keep-alive.** An MV3 event page can be suspended when idle. While a reader is open, it pings
  the background every 15 s. If the connection drops anyway, the reader shows the model problem
  with *Try again*, which reconnects. It never falls back silently.
- **ONNX Runtime's WASM comes from the extension, never a CDN.** Transformers.js points ONNX
  Runtime at jsdelivr for its WASM loader, and extension pages may only run their own scripts.
  The extension build defines `VITE_ORT_LOCAL_WASM`, and the worker then clears `wasmPaths`. ONNX
  Runtime falls back to the loader bundled into it and the `.wasm` file Vite emits. The app is
  unchanged.
- **Readability chooses the text and the live DOM decides everything else.**
  - Readability runs on a clone of the page. Each element in the clone is tagged with
    `data-rsvp-i`, its index among the live elements. Attributes survive Readability's retries,
    which re-parse the page from its HTML, so after a retry node identities are gone but the tags
    remain.
  - The tags of the elements Readability keeps give a set of live elements. A live text node is
    read when its parent is in that set.
  - The walk over the live page gives:
    - paragraphs (computed `display`, `<br>`, newlines in preformatted text);
    - visibility (`display: none`, `content-visibility: hidden`, `visibility`, one-pixel
      "visually hidden" text);
    - positions.
  - If the article has fewer than 50 words, the reader uses the visible text of `article`,
    `main` or `body` instead. A selection is read clipped to its ranges.
- **Words are built from page positions, not by re-normalizing the text.**
  - Whitespace-delimited chunks are collected across text nodes, so `<b>wor</b>ld` is one word.
    Each chunk records its start and end as a text node and an offset.
  - `normalizeChunk` (split out of `normalizeText`) applies the same character normalization to
    each chunk. Pieces of a chunk that normalization splits share its range.
  - The text is the chunks joined with single spaces and paragraphs with `"\n\n"`.
  - `segment(text)` must give back exactly these chunks, or the page is refused with an error.
    The tests also check that `normalizeText(text) === text`.
- **Highlighting uses the CSS Custom Highlight API.** It paints over text without changing the
  page's DOM or layout. There are two highlights: the words on screen, and optionally the current
  sentence. Their styles are inserted with `scripting.insertCSS`. Where the API is missing, boxes
  from `getClientRects()` are drawn in the overlay instead.
- **Following.** When a word leaves the band between 15% and 65% of the window height (and clear
  of the card), the page or the nearest scrolling element scrolls to put it a third of the way
  down. A wheel, touch, scroll key or scrollbar drag holds following for 3 s.
  - When the card covers a word that scrolling cannot uncover (the opening lines with the card at
    the top, or the last lines with it at the bottom), the card moves to the other edge.
- **Only on request.** `activeTab` and `scripting` inject the content script when the toolbar
  button, the shortcut or a menu item is used, so the extension needs no host permissions. "Read
  from here" uses `menus.getTargetElement`, because the content script is not present until the
  click.
- **The overlay is plain DOM in a closed shadow root**, with the app's stage markup, so
  `WordDisplay` drives it unchanged. `PagePlayer` (`src/extension/controller.ts`) is the app
  Reader's scheduler wiring without React. The options page reuses `SettingsPanel` through a new
  `page` variant, which leaves out the drawer and the rows that only the app uses.
- **Fixed pacing loads no model** in the extension. Turning surprisal pacing back on starts
  scoring.
- **Positions and caches are keyed by the SHA-256 of the text**, computed in the background,
  because `crypto.subtle` is missing in content scripts on plain-http pages. The position key is
  `pos:page:<hash>`.
- **Checked in Firefox 160** (headless, through WebDriver BiDi, with a test-only trigger, because
  automation cannot press the toolbar button). On a local article page:
  - the reader opens on the article heading, and the navigation and sidebar are left out;
  - the box and the page highlight move together;
  - DistilGPT-2 on WASM scores in the background (the chip shows "Scored 56%" while playing);
  - a click while paused jumps to the clicked word;
  - forty presses of → leave the word 253 px from the top of an 800 px window;
  - Esc removes the highlights.

### Extension, second round

- **The card keeps one size.** The status line always takes its one-line height. The hint is
  made invisible while playing, not removed. The control bar never wraps, and its changing
  labels have fixed widths. The card used to grow and shrink as messages came and went (a
  download line, "Scoring ahead…"), and controls could move to a second line. At the bottom of
  the window, that moved the whole card.
- **Stepping aside is sticky, and never for a dragged card.** A Top or Bottom card that covers
  words which scrolling cannot uncover moves to the other edge once. It stays there until the
  position setting itself changes. Before, any settings change, even ↑ / ↓ for speed, put it
  back, so it could bounce. A card the reader dragged is never moved by the reader: dropping it
  over the word being read used to set off the step-aside straight away.
- **Dragging.** Any part of the card that is not a control is a handle, the flashing word
  included. A press becomes a drag after 5 px. The click that ends a drag is swallowed, so a drag
  never plays or pauses. The place is stored as fractions of the free space left of and above
  the card (`ExtSettings.at`), so it holds when the window is resized. Choosing Top or Bottom
  returns the card to that edge.
- **Highlight mode replaces the sentence on/off switch.** The modes are word + sentence, word,
  and sentence only; the old setting is migrated. When the sentence is the only mark, it uses its
  own, stronger highlight (`rsvp-reader-sentence-only`). Following still tracks the word, so the
  page scrolls no more often than before.
- **Keep-open needs host access, and asks for it in the options page.** `activeTab` access ends
  when the tab navigates. So putting the reader back after a page load needs `<all_urls>`, which
  is declared as an optional host permission. Firefox grants it only from a click in an extension
  page. The overlay's checkbox therefore asks the background, which opens the options page when
  the access is missing, and the options page's switch calls `permissions.request`.
  - The background keeps the tabs that have an open reader in `storage.session`, because the
    event page may be suspended between loads. The reader reports opening and explicit closing.
    A page that unloads reports nothing, so its tab stays marked.
  - On `tabs.onUpdated` with status `complete`, the background sends `reopen`. The content script
    ignores it if a reader is already open.
- **Pages that change in place are re-read.** The reader checks the address once a second,
  ignoring the `#fragment`. When it changes, the reader pauses and reads the page again after
  0.6, 1, 1.5 and 2.5 s, until the text differs from before. This happens regardless of
  keep-open, since the old text has left the page.
- **Checked in Firefox 160:**
  - sentence-only marks just the sentence and moves sentence by sentence;
  - the card is the same size paused and playing;
  - a drag moves the card and does not start playback;
  - a click on the moved word plays;
  - an in-place page change is re-read;
  - with keep-open on, loading another URL in the tab opens the reader again, at the saved
    position for that text.
