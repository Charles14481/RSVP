import type { Word } from '../types';

/** Paragraph separator in normalized text. */
export const PARAGRAPH_BREAK = '\n\n';

/** Chunks longer than this are split at hyphens and slashes for display. */
export const MAX_CHUNK_CHARS = 20;

const INVISIBLE = /[\u00AD\u200B\u2060\uFEFF]/g;
// C0/C1 control characters except line feed (tab included: it becomes a space).
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Normalize raw text: NFKC, whitespace runs collapsed to single spaces,
 * paragraphs joined by exactly "\n\n". The result contains no whitespace other
 * than single ASCII spaces inside paragraphs and "\n\n" between them, which is
 * what the token-to-word alignment relies on.
 */
export function normalizeText(raw: string): string {
  return splitParagraphs(normalizeChars(raw)).join(PARAGRAPH_BREAK);
}

/** Lone surrogates, NFKC, line separators to newlines, invisible characters removed, controls to spaces. */
function normalizeChars(raw: string): string {
  let t = raw.replace(LONE_SURROGATE, '\uFFFD').normalize('NFKC');
  t = t.replace(/\r\n?/g, '\n').replace(/\u2029/g, '\n\n').replace(/\u2028/g, '\n');
  return t.replace(INVISIBLE, '').replace(CONTROL, ' ');
}

/**
 * The words of one whitespace-delimited chunk of raw text, after the same
 * character normalization normalizeText applies. Usually one word; none when
 * the chunk was only invisible characters; several when normalization turned
 * a character into whitespace. Joining a paragraph’s results with single
 * spaces gives what normalizeText makes of it (apart from the hard-wrap rule).
 */
export function normalizeChunk(chunk: string): string[] {
  return normalizeChars(chunk).split(/\s+/).filter(Boolean);
}

/**
 * Blank lines always separate paragraphs. A single newline is a paragraph
 * break too, unless the document looks hard-wrapped (no line longer than 100
 * characters) and the line was full, i.e. the next line's first word would
 * not have fit within about three quarters of the wrap width.
 */
function splitParagraphs(t: string): string[] {
  const lines = t.split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  const maxLen = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const nonBlank = lines.reduce((c, l) => c + (l ? 1 : 0), 0);
  const hardWrapped = maxLen <= 100 && nonBlank >= 3;

  const paragraphs: string[] = [];
  let current = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) {
      if (current) paragraphs.push(current);
      current = '';
      continue;
    }
    current = current ? current + ' ' + line : line;
    const next = lines[i + 1];
    if (!next) continue;
    let softWrap = false;
    if (hardWrapped) {
      const space = next.indexOf(' ');
      const nextWordLen = space === -1 ? next.length : space;
      softWrap = line.length + 1 + nextWordLen > maxLen * 0.75;
    }
    if (!softWrap) {
      paragraphs.push(current);
      current = '';
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs;
}

// Abbreviations (lowercase, without the final period) that never end a sentence.
const NEVER_END = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'mt', 'vs', 'v', 'e.g', 'i.e', 'cf', 'viz',
  'fig', 'figs', 'eq', 'eqs', 'vol', 'vols', 'pp', 'p', 'ch', 'sec', 'approx', 'ca',
  'gen', 'col', 'capt', 'lt', 'sgt', 'cmdr', 'rev', 'hon', 'gov', 'sen', 'rep', 'pres',
  'messrs', 'mme', 'mlle', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep',
  'sept', 'oct', 'nov', 'dec',
]);
// Abbreviations that end a sentence only when the next word is capitalized.
const MAYBE_END = new Set([
  'etc', 'al', 'inc', 'ltd', 'co', 'corp', 'jr', 'sr', 'ed', 'eds', 'est', 'dept',
  'a.m', 'p.m', 'ph.d', 'm.d', 'b.a', 'm.a', 'ave', 'blvd', 'rd',
]);

const TERMINAL = /([.!?]+)["'”’)\]}»]*$/;
const STARTS_LOWER = /^[^\p{L}\p{N}]*\p{Ll}/u;
const STARTS_UPPER = /^[^\p{L}\p{N}]*\p{Lu}/u;
const STARTS_DIGIT = /^[^\p{L}\p{N}]*\p{N}/u;

/**
 * Does this whitespace-delimited chunk end a sentence? `next` is the following
 * chunk in the same paragraph (undefined at the paragraph end).
 */
export function isSentenceEnd(chunk: string, next: string | undefined, firstInParagraph = false): boolean {
  const m = TERMINAL.exec(chunk);
  if (!m) return false;
  const punct = m[1];
  if (/[!?]/.test(punct)) return true;
  if (next === undefined) return true;

  const nextLower = STARTS_LOWER.test(next);
  if (punct.length >= 2) return !nextLower; // ellipsis

  const stem = chunk
    .slice(0, m.index)
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .toLowerCase();
  if (NEVER_END.has(stem)) return false;
  if (stem === 'no') return !STARTS_DIGIT.test(next); // "No. 5" vs "The answer is no."
  // A single initial: "J. K. Rowling".
  if (stem.length === 1 && /\p{L}/u.test(stem) && /\p{Lu}/u.test(chunk)) return false;
  // List markers opening a paragraph: "1." "a." "iv."
  if (firstInParagraph && /^(\d+|[a-z]|[ivxlc]+)$/.test(stem)) return false;
  // Known abbreviations and dotted initialisms such as "U.S." or "a.m.".
  if (MAYBE_END.has(stem) || /^(\p{L}\.)+\p{L}$/u.test(stem)) return STARTS_UPPER.test(next);
  return !nextLower;
}

const DELIMS = '\\-/\\\\\u2010-\u2015';
const SPLIT_SEGMENTS = new RegExp(`[^${DELIMS}]*[${DELIMS}]+|[^${DELIMS}]+$`, 'g');

/**
 * Split a chunk longer than `max` characters after hyphens or slashes so URLs
 * and long compounds fit on screen. Pieces concatenate back to the chunk.
 */
export function splitLongChunk(chunk: string, max = MAX_CHUNK_CHARS): string[] {
  if (chunk.length <= max) return [chunk];
  const segments = chunk.match(SPLIT_SEGMENTS);
  if (!segments || segments.length < 2) return [chunk];
  const pieces: string[] = [];
  let current = '';
  for (const seg of segments) {
    if (current && current.length + seg.length > max) {
      pieces.push(current);
      current = seg;
    } else {
      current += seg;
    }
  }
  if (current) {
    // Do not strand a fragment with no letters or digits ("-," or "/").
    if (pieces.length && !/[\p{L}\p{N}]/u.test(current)) pieces[pieces.length - 1] += current;
    else pieces.push(current);
  }
  return pieces;
}

/** Segment normalized text (see normalizeText) into display words. */
export function segment(normalized: string): Word[] {
  const words: Word[] = [];
  if (!normalized) return words;
  const paragraphs = normalized.split(PARAGRAPH_BREAK);
  for (let p = 0; p < paragraphs.length; p++) {
    const chunks = paragraphs[p].split(' ');
    for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c];
      if (!chunk) continue;
      const paragraphEnd = c === chunks.length - 1;
      const sentenceEnd = paragraphEnd || isSentenceEnd(chunk, chunks[c + 1], c === 0);
      const pieces = splitLongChunk(chunk);
      for (let k = 0; k < pieces.length; k++) {
        const last = k === pieces.length - 1;
        const word: Word = {
          index: words.length,
          text: pieces[k],
          paragraphIndex: p,
          sentenceEnd: last && sentenceEnd,
          paragraphEnd: last && paragraphEnd,
        };
        if (k > 0) word.glued = true;
        words.push(word);
      }
    }
  }
  return words;
}

/** Normalize and segment in one step. */
export function segmentText(raw: string): { text: string; words: Word[] } {
  const text = normalizeText(raw);
  return { text, words: segment(text) };
}

/**
 * The whitespace-delimited chunks the language model sees: display words with
 * glued pieces merged back together. `first[c]` is the index of the first
 * display word of chunk c; `first[chunks.length]` is words.length.
 */
export function chunksOf(words: readonly Word[]): { chunks: string[]; first: Int32Array } {
  const chunks: string[] = [];
  const first: number[] = [];
  for (const w of words) {
    if (w.glued && chunks.length) {
      chunks[chunks.length - 1] += w.text;
    } else {
      first.push(w.index);
      chunks.push(w.text);
    }
  }
  first.push(words.length);
  return { chunks, first: Int32Array.from(first) };
}

/** Rebuild the normalized text from display words. */
export function wordsToText(words: readonly Word[]): string {
  let out = '';
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (i > 0 && !w.glued) out += words[i - 1].paragraphEnd ? PARAGRAPH_BREAK : ' ';
    out += w.text;
  }
  return out;
}
