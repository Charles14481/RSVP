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
  S opens settings (additions to the plan's shortcuts).

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
