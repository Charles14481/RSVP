/**
 * GET /api/fetch?url=... returns the raw bytes of a public web page so the
 * browser can extract an article from it. Written against the Fetch API so
 * the same handler runs as Vite dev middleware (Node) and as a Cloudflare
 * Worker.
 *
 * Rules: http and https only; private, loopback and link-local hosts are
 * rejected, also after every redirect; 5 MB cap; 10 s timeout; only allowed
 * origins may call it. The body is served as text/plain with nosniff so the
 * fetched HTML can never render on this origin.
 */

export interface ProxyOptions {
  /** Origins allowed to call the proxy (exact match, e.g. "https://reader.example"). */
  allowedOrigins: string[];
  /** Accept requests with no Origin header (same-origin GETs in dev send none). */
  allowMissingOrigin?: boolean;
  /** Resolve a hostname to IP addresses so DNS answers can be checked too (Node only). */
  resolve?: (hostname: string) => Promise<string[]>;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

export const MAX_BYTES = 5 * 1024 * 1024;
export const TIMEOUT_MS = 10_000;

const ACCEPTED_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain|application\/xml|text\/xml)\b/i;

export class ProxyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** True for IPv4 addresses that must not be fetched. */
function privateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && p[2] === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expand an IPv6 literal to eight 16-bit groups, or null if malformed. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const p = v4[1].split('.').map(Number);
    s = s.slice(0, v4.index) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string) => (h ? h.split(':').map((g) => parseInt(g, 16)) : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const groups = [...head, ...new Array(Math.max(0, fill)).fill(0), ...tail];
  return groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function privateIPv6(ip: string): boolean {
  const g = ipv6Groups(ip.replace(/^\[|\]$/g, '').replace(/%.*$/, ''));
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible and NAT64 (64:ff9b::/96) forms.
  const mapped = g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0);
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0);
  if (mapped || nat64) return privateIPv4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  return ip.includes(':') ? privateIPv6(ip) : privateIPv4(ip);
}

const IPV4_LITERAL = /^\d+\.\d+\.\d+\.\d+$/;
const BLOCKED_NAMES = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa)$/i;

/** Validate a target URL; throws ProxyError if it must not be fetched. */
export async function checkTarget(raw: string, resolve?: ProxyOptions['resolve']): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProxyError(400, 'That is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ProxyError(400, 'Only http and https addresses can be fetched.');
  if (url.username || url.password) throw new ProxyError(400, 'Addresses with credentials are not allowed.');
  if (url.port && !['80', '443', '8080', '8443'].includes(url.port)) throw new ProxyError(400, 'That port is not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) throw new ProxyError(400, 'The address has no host.');
  const literal = IPV4_LITERAL.test(host) || host.includes(':');
  // Numeric forms the URL parser normalizes (e.g. "0x7f.1", "2130706433") come out as dotted IPv4 here.
  if (literal ? isPrivateAddress(host) : BLOCKED_NAMES.test(host) || !host.includes('.')) {
    throw new ProxyError(403, 'Private and local addresses cannot be fetched.');
  }
  if (!literal && resolve) {
    let addresses: string[];
    try {
      addresses = await resolve(host);
    } catch {
      throw new ProxyError(502, `Could not find ${host}.`);
    }
    if (!addresses.length || addresses.some(isPrivateAddress)) throw new ProxyError(403, 'Private and local addresses cannot be fetched.');
  }
  return url;
}

function corsHeaders(origin: string | null, allowed: boolean): Record<string, string> {
  return allowed && origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Expose-Headers': 'X-Upstream-Content-Type, X-Final-Url',
        Vary: 'Origin',
      }
    : { Vary: 'Origin' };
}

function errorResponse(status: number, message: string, cors: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...cors },
  });
}

export async function handleFetch(request: Request, options: ProxyOptions): Promise<Response> {
  const origin = request.headers.get('Origin');
  const originAllowed = origin ? options.allowedOrigins.includes(origin) : Boolean(options.allowMissingOrigin);
  const cors = corsHeaders(origin, originAllowed);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: originAllowed ? 204 : 403,
      headers: { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' },
    });
  }
  if (!originAllowed) return errorResponse(403, 'This origin may not use the fetch proxy.', cors);
  if (request.method !== 'GET') return errorResponse(405, 'Only GET is supported.', cors);

  const target = new URL(request.url).searchParams.get('url');
  if (!target) return errorResponse(400, 'Missing ?url= parameter.', cors);

  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const signal = AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS);

  try {
    let url = await checkTarget(target, options.resolve);
    let upstream: Response | null = null;
    for (let hop = 0; hop <= (options.maxRedirects ?? 5); hop++) {
      upstream = await fetchImpl(url.toString(), {
        redirect: 'manual',
        signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8',
          'User-Agent': 'Mozilla/5.0 (compatible; SurprisalReader/1.0; +article-fetch)',
        },
      });
      if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.get('Location')) {
        void upstream.body?.cancel();
        url = await checkTarget(new URL(upstream.headers.get('Location')!, url).toString(), options.resolve);
        upstream = null;
        continue;
      }
      break;
    }
    if (!upstream) throw new ProxyError(508, 'Too many redirects.');
    if (!upstream.ok) {
      void upstream.body?.cancel();
      throw new ProxyError(502, `The site answered ${upstream.status} ${upstream.statusText}`.trim() + '.');
    }
    const type = upstream.headers.get('Content-Type') ?? 'text/html';
    if (!ACCEPTED_TYPES.test(type)) {
      void upstream.body?.cancel();
      throw new ProxyError(415, `That address is not a web page (${type.split(';')[0]}).`);
    }
    const declared = Number(upstream.headers.get('Content-Length'));
    if (declared > maxBytes) {
      void upstream.body?.cancel();
      throw new ProxyError(413, 'The page is larger than 5 MB.');
    }
    const body = await readCapped(upstream, maxBytes);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=x-user-defined',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'no-store',
        'X-Upstream-Content-Type': type,
        'X-Final-Url': url.toString(),
        ...cors,
      },
    });
  } catch (e) {
    if (e instanceof ProxyError) return errorResponse(e.status, e.message, cors);
    if (signal.aborted) return errorResponse(504, 'The site took longer than 10 seconds to respond.', cors);
    return errorResponse(502, `Could not fetch the page: ${e instanceof Error ? e.message : String(e)}`, cors);
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel();
      throw new ProxyError(413, 'The page is larger than 5 MB.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
