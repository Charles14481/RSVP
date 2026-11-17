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
