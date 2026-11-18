# Surprisal Reader

A personal RSVP reader: text is shown one word at a time at a fixed spot on the screen, and each
word stays up for a time that grows with its **surprisal** under a small language model.
Predictable words flash by; unexpected ones linger.

Everything runs in the browser. There are no accounts and no backend, and your text never leaves
the device. The one exception is importing from a URL, which goes through a tiny fetch proxy.

## Why surprisal

Reading-time studies find that the time people spend on a word is roughly **linear in its
surprisal**, −log₂ p(word | context). It is not linear in 1/p, and not in perplexity. Small models
of GPT-2 size predict human reading times better than large ones, so GPT-2 small is the right
model here, not a compromise.

## How a word's duration is computed

With T = 60000 / target WPM and sᵢ the word's surprisal in bits:

1. **Spillover:** s′ᵢ = (1 − L)·sᵢ + L·sᵢ₋₁. Part of a word's processing cost lands on the next
   word. The last word keeps its own share, so the document total is unchanged. L defaults to 0.25.
2. **Mix:** dᵢ = T·((1 − A) + A·s′ᵢ / mean_s). A is the *surprisal strength* (default 0.7), and
   mean_s is a running mean seeded per model. **A = 0 is classic fixed-rate RSVP.**
3. **Length:** add 8 ms per character beyond 8.
4. **Clamp:** keep within [80 ms, 4·T].
5. **Pauses**, added after clamping: comma, semicolon, colon or dash +0.5·T; sentence end +1·T;
   paragraph end +2·T.

The reader shows both the target WPM and the effective WPM, which includes pauses and clamps.
Durations are computed from stored surprisal when needed, so every setting change applies to the
very next word.

## Using it

- **Import:** paste text, open a `.txt`/`.md` or PDF file, or fetch a web page. Every route ends
  in an editable preview so you can cut headers, references or other junk before reading.
- **Model:** the model downloads once (128 MB on the CPU backend, 251 MB on WebGPU) and is cached
  by the browser. Scoring runs in a background worker and streams ahead of you. Playback starts as
  soon as the first window is scored. If you catch up with the scorer, the reader shows a brief
  buffering state; it never falls back silently to fixed timing.
- **Pausing:** when paused, the reader shows the surrounding text with your place marked. It
  scrolls, and more loads as you near either end. Click any word to continue from there.
  Re-reading is the thing RSVP takes away, so it is one click. By default, playback resumes from
  the start of the sentence. With **Show the text while playing** (Settings, Display), the text
  stays up while playing, dimmed, with the word on screen marked and kept in view.
- **Several words at a time:** Settings → Pace → Words at a time (or keys 1, 2, 3) shows short
  phrases instead of single words. A group ends at any punctuation that earns a pause and stays
  within a width limit; it stays up for the sum of its words' surprisal-paced durations, so the
  effective rate is the same at every size.
- **Starting and stopping:** Space, the Play button or a click on the word starts reading. A click
  anywhere pauses, but a click beside the text does not start reading.
- **Inspector (I):** the text with each word shaded by surprisal, and its duration on hover.
  Click a word to see the model's ten most likely next tokens at that point and how the actual
  word ranked. By default it scrolls through the whole text. Use it to tune the settings and to
  spot alignment problems.
- **Library:** documents, reading positions, settings and surprisal scores are kept in IndexedDB.
  A fully scored document reopens instantly without loading the model. A new library starts with
  two short texts meant to be read in the reader: a guide to the controls and an introduction to
  the pacing.
- **Offline:** the built app installs a service worker and can be installed as an app. Once the
  model has been downloaded, reading and scoring new text work without a network. Only URL import
  needs a connection.
- **Boundary correction (experimental):** a setting that corrects word probabilities for
  tokenizers that put the space at the start of a word (Pimentel & Meister 2024; Oh & Schuler 2024).
  It changes word surprisal by a few tenths of a bit on average.

### Keyboard

| Key | Action |
| --- | --- |
| Space | Play / pause |
| ← / → | Previous / next sentence |
| ↑ / ↓ | ±25 WPM |
| R | Restart the paragraph |
| 1 / 2 / 3 | Words shown at a time |
| I / S / ? | Inspector / settings / shortcut list |
| Esc | Close a panel, or back to the library |

On a touch screen, tap the word to play or pause; a tap elsewhere only pauses. The ‹ and › buttons step by sentence.

## Running it

Requires Node 22.18 or newer.

```sh
npm install
npm run dev          # http://localhost:5173, including the /api/fetch proxy for URL import
npm test             # unit tests (offline: the GPT-2 tokenizer is vendored for the alignment tests)
npm run build        # type-check and build to dist/
```

### Deeper checks

| Command | What it does |
| --- | --- |
| `npm run reference` | Writes PyTorch GPT-2 / DistilGPT-2 per-token surprisal for the fixture passages to `test/fixtures/reference/` (needs `.venv` with `torch` and `transformers`; see `scripts/reference_surprisal.py`). |
| `npm run test:slow` | Runs the browser scoring core in Node with fp32 weights and compares with the reference (agrees to about 1e-4 bits per token). It also checks windowing, the quantized models and the mean seed. Downloads the models on first run. |
| `npm run smoke` | Builds, then drives the installed Chrome headlessly: loads the sample, plays, checks onset timing, the inspector and settings, then reloads to check persistence. Add `-- --wasm` to force the CPU backend. |
| `npm run smoke:pdf` | Generates a 300-page PDF, imports it, and measures time to first word and UI responsiveness while scoring. |
| `npm run smoke:url` | Builds with the proxy enabled and imports a Wikipedia article through it. |
| `npm run smoke:offline` | Installs the service worker, then cuts the network: reopens a cached document and scores a new one offline. |

The smoke scripts use `playwright-core` with the Chrome already installed on the machine. No
browser is downloaded.

## Deploying

The app is static: serve `dist/` anywhere. Two things matter:

1. **Cross-origin isolation headers**, so ONNX Runtime can use multithreaded WASM:

   ```
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: require-corp
   ```

   Without them, everything still works, but CPU scoring is single-threaded.

2. **URL import** needs the fetch proxy, a Cloudflare Worker in `worker/fetch-proxy.ts`:

   ```sh
   # set ALLOWED_ORIGINS in wrangler.toml to where the reader is hosted, then
   npx wrangler deploy
   VITE_FETCH_PROXY_URL=https://surprisal-reader-fetch.<account>.workers.dev/api/fetch npm run build
   ```

   The proxy accepts only http(s), refuses private and loopback addresses (including after
   redirects), caps pages at 5 MB, times out after 10 s, and answers only allowed origins. Without
   a proxy, the "From a web page" option explains that the text has to be pasted instead.

## Limitations

- **English only, in practice.** GPT-2 and DistilGPT-2 were trained on English web text. Other
  languages are tokenized into many small pieces and get inflated, noisy surprisal. The timing is
  tuned for English prose.
- **No OCR.** Scanned PDFs without a text layer are reported as such. PDF layout reconstruction
  handles running headers, page numbers, hyphenation and clear two-column pages. Anything
  subtler is left to the preview.
- The 8-bit CPU model differs from full precision by about a bit per word. It correlates 0.96 to
  0.99 with fp32, and because durations are relative to the running mean, the bias cancels.
- Out of scope: accounts, sync, EPUB, comprehension quizzes and experiment logging.

## Project layout

```
src/segment/   text normalization, word segmentation, sentence navigation
src/surprisal/ token alignment, window planning, scoring core, worker, client
src/timing/    the duration model (pure)
src/player/    rAF scheduler, ORP display, session state
src/ingest/    PDF layout + pdf.js wrapper, URL article extraction
src/store/     IndexedDB persistence
src/ui/        library, import preview, reader, settings, inspector
server/        fetch proxy handler and Vite middleware
worker/        the same proxy as a Cloudflare Worker
tools/         build-time service worker generator
public/        manifest and icon
scripts/       reference script, smoke tests
```

Deviations from the original plan, with reasons, are recorded in [DECISIONS.md](DECISIONS.md).
