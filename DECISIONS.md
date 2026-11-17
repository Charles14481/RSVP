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
