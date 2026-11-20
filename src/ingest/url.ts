import { Readability } from '@mozilla/readability';
import { htmlToMarkdown } from './html';

export class UrlImportError extends Error {
  constructor(
    message: string,
    /** True when pasting the text by hand is the only way forward. */
    readonly suggestPaste = true,
  ) {
    super(message);
    this.name = 'UrlImportError';
  }
}

export interface Article {
  title: string;
  /** Plain text, one paragraph per block. */
  text: string;
  /** The same article as Markdown, keeping emphasis, headings, lists and links. */
  markdown: string;
  byline?: string;
  siteName?: string;
  url: string;
}

/**
 * Where the fetch proxy lives: VITE_FETCH_PROXY_URL if set (relative or
 * absolute), otherwise the dev server's own /api/fetch, otherwise none.
 */
export function proxyEndpoint(): string | null {
  const configured = import.meta.env.VITE_FETCH_PROXY_URL as string | undefined;
  if (configured) return configured;
  return import.meta.env.DEV ? '/api/fetch' : null;
}

/** Charset from the Content-Type header, a byte order mark, or a <meta> tag; UTF-8 otherwise. */
export function detectCharset(contentType: string | null, bytes: Uint8Array): string {
  const header = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? '');
  if (header) return header[1];
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  const meta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head);
  return meta ? meta[1] : 'utf-8';
}

export function decodeHtml(bytes: Uint8Array, contentType: string | null): string {
  try {
    return new TextDecoder(detectCharset(contentType, bytes)).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'IFRAME', 'OBJECT', 'EMBED', 'BUTTON', 'SELECT', 'TEXTAREA', 'INPUT', 'CANVAS', 'VIDEO', 'AUDIO', 'PICTURE', 'IMG']);
/** Elements whose whole text is one paragraph. */
const LEAF_BLOCKS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'PRE', 'FIGCAPTION', 'DT', 'DD', 'TD', 'TH', 'CAPTION', 'ADDRESS', 'SUMMARY']);
/** Elements that separate paragraphs but may contain other blocks. */
const CONTAINERS = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'NAV', 'UL', 'OL', 'DL', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'FIGURE', 'BLOCKQUOTE', 'FORM', 'FIELDSET', 'DETAILS', 'HR', 'BODY', 'HTML']);

/** Text of an element with <br> as a line break; never touches innerHTML. */
function textOf(el: Element): string {
  let out = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) out += node.textContent ?? '';
    else if (node.nodeType === 1) {
      const child = node as Element;
      if (SKIP.has(child.tagName)) continue;
      out += child.tagName === 'BR' ? '\n' : textOf(child);
    }
  }
  return out;
}

/**
 * Plain text with paragraph breaks from an inert DOM (from DOMParser, never
 * attached to the page): one paragraph per block element, read through
 * textContent only.
 */
export function blocksToText(root: Element): string {
  const paragraphs: string[] = [];
  let inline = '';
  const flush = () => {
    const t = inline.replace(/[ \t\r\f\v\u00A0]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
    if (t) paragraphs.push(t);
    inline = '';
  };
  const walk = (el: Element) => {
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3) {
        inline += node.textContent ?? '';
        continue;
      }
      if (node.nodeType !== 1) continue;
      const child = node as Element;
      const tag = child.tagName;
      if (SKIP.has(tag)) continue;
      if (tag === 'BR') inline += '\n';
      else if (LEAF_BLOCKS.has(tag)) {
        flush();
        inline = textOf(child);
        flush();
      } else if (CONTAINERS.has(tag)) {
        flush();
        walk(child);
        flush();
      } else inline += textOf(child);
    }
  };
  walk(root);
  flush();
  return paragraphs.join('\n\n');
}

/** Drop a trailing " | Site Name" (or " - ", " \u2014 ", " :: ") when the site name is known. */
function cleanTitle(title: string, siteName?: string | null): string {
  const t = title.replace(/\s+/g, ' ').trim();
  if (!siteName) return t;
  const escaped = siteName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return t.replace(new RegExp(`\\s+(?:[|\\-\u2013\u2014·:]{1,2})\\s+${escaped}$`, 'i'), '').trim() || t;
}

/** Run Readability on fetched HTML and turn the article into plain text. */
export function extractArticle(html: string, url: string): Article {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  // Lets Readability resolve relative links; nothing from this document is ever rendered.
  const base = doc.createElement('base');
  base.href = url;
  doc.head?.prepend(base);
  const parsed = new Readability(doc, { charThreshold: 300 }).parse();
  if (!parsed?.content) throw new UrlImportError('Could not find an article on that page.');
  const articleDoc = parser.parseFromString(parsed.content, 'text/html');
  const text = blocksToText(articleDoc.body);
  if (text.split(/\s+/).length < 30) throw new UrlImportError('The page has too little article text to read.');
  return {
    title: cleanTitle(parsed.title ?? '', parsed.siteName) || new URL(url).hostname,
    text,
    markdown: htmlToMarkdown(articleDoc.body),
    ...(parsed.byline ? { byline: parsed.byline.trim() } : {}),
    ...(parsed.siteName ? { siteName: parsed.siteName.trim() } : {}),
    url,
  };
}

/**
 * A saved web page or other HTML file as Markdown: the article if Readability
 * finds one, otherwise the whole body.
 */
export function htmlDocumentToMarkdown(html: string, url: string): { title: string; markdown: string } {
  try {
    const a = extractArticle(html, url);
    return { title: a.title, markdown: a.markdown };
  } catch {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return { title: doc.title.replace(/\s+/g, ' ').trim(), markdown: doc.body ? htmlToMarkdown(doc.body) : '' };
  }
}

/** Fetch a page through the proxy and extract its article. */
export async function fetchArticle(rawUrl: string, signal?: AbortSignal): Promise<Article> {
  const endpoint = proxyEndpoint();
  if (!endpoint) {
    throw new UrlImportError('Fetching web pages needs the small fetch proxy, and none is configured for this deployment.');
  }
  let target = rawUrl.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) target = `https://${target}`;
  let res: Response;
  try {
    res = await fetch(`${endpoint}${endpoint.includes('?') ? '&' : '?'}url=${encodeURIComponent(target)}`, { signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new UrlImportError('Could not reach the fetch proxy.');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new UrlImportError(body?.error ?? `The fetch proxy answered ${res.status}.`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const finalUrl = res.headers.get('X-Final-Url') ?? target;
  const html = decodeHtml(bytes, res.headers.get('X-Upstream-Content-Type'));
  return extractArticle(html, finalUrl);
}
