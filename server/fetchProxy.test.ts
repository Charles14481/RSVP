import { describe, expect, it } from 'vitest';
import { checkTarget, handleFetch, isPrivateAddress, type ProxyOptions } from './fetchProxy';

const ORIGIN = 'https://reader.example';

function upstream(body: string | Uint8Array<ArrayBuffer>, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, ...init });
}

function call(target: string, opts: Partial<ProxyOptions> = {}, headers: Record<string, string> = { Origin: ORIGIN }) {
  const req = new Request(`https://proxy.example/api/fetch?url=${encodeURIComponent(target)}`, { headers });
  return handleFetch(req, {
    allowedOrigins: [ORIGIN],
    resolve: async () => ['93.184.216.34'],
    fetchImpl: (async () => upstream('<html><title>Hi</title></html>')) as typeof fetch,
    ...opts,
  });
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    'fc00::abcd',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:192.168.0.1',
    '64:ff9b::a00:1',
    'not-an-ip',
  ])('rejects %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])('allows %s', (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe('checkTarget', () => {
  it.each([
    ['ftp://example.com/', 400],
    ['file:///etc/passwd', 400],
    ['javascript:alert(1)', 400],
    ['not a url', 400],
    ['http://user:pass@example.com/', 400],
    ['http://example.com:22/', 400],
    ['http://localhost/', 403],
    ['http://foo.localhost/', 403],
    ['http://printer.local/', 403],
    ['http://intranet/', 403],
    ['http://127.0.0.1/', 403],
    ['http://2130706433/', 403], // decimal 127.0.0.1
    ['http://0x7f.0.0.1/', 403],
    ['http://[::1]/', 403],
    ['http://[::ffff:127.0.0.1]/', 403],
    ['http://169.254.169.254/latest/meta-data/', 403],
  ])('rejects %s', async (url, status) => {
    await expect(checkTarget(url)).rejects.toMatchObject({ status });
  });

  it('rejects hostnames that resolve to private addresses', async () => {
    await expect(checkTarget('https://rebind.example/', async () => ['93.184.216.34', '10.0.0.5'])).rejects.toMatchObject({ status: 403 });
  });

  it('accepts public http and https addresses', async () => {
    expect((await checkTarget('https://example.com/a?b=c', async () => ['93.184.216.34'])).hostname).toBe('example.com');
    expect((await checkTarget('http://93.184.216.34:8080/')).port).toBe('8080');
  });
});

describe('handleFetch', () => {
  it('returns the page bytes as inert text with the upstream type', async () => {
    const res = await call('https://example.com/article');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/^text\/plain/);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Upstream-Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('X-Final-Url')).toBe('https://example.com/article');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(await res.text()).toBe('<html><title>Hi</title></html>');
  });

  it('refuses other origins and, unless allowed, requests without one', async () => {
    const other = await call('https://example.com/', {}, { Origin: 'https://evil.example' });
    expect(other.status).toBe(403);
    expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect((await call('https://example.com/', {}, {})).status).toBe(403);
    expect((await call('https://example.com/', { allowMissingOrigin: true }, {})).status).toBe(200);
  });

  it('answers CORS preflight only for allowed origins', async () => {
    const pre = (origin: string) => handleFetch(new Request('https://proxy.example/api/fetch', { method: 'OPTIONS', headers: { Origin: origin } }), { allowedOrigins: [ORIGIN] });
    expect((await pre(ORIGIN)).status).toBe(204);
    expect((await pre('https://evil.example')).status).toBe(403);
  });

  it('requires a url parameter', async () => {
    const res = await handleFetch(new Request('https://proxy.example/api/fetch', { headers: { Origin: ORIGIN } }), { allowedOrigins: [ORIGIN] });
    expect(res.status).toBe(400);
  });

  it('re-checks every redirect target', async () => {
    const hops: string[] = [];
    const fetchImpl = (async (u: string) => {
      hops.push(u);
      if (u === 'https://example.com/a') return new Response(null, { status: 302, headers: { Location: '/b' } });
      if (u === 'https://example.com/b') return new Response(null, { status: 301, headers: { Location: 'http://127.0.0.1/admin' } });
      return upstream('should not get here');
    }) as typeof fetch;
    const res = await call('https://example.com/a', { fetchImpl });
    expect(res.status).toBe(403);
    expect(hops).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('follows safe redirects and reports the final URL', async () => {
    const fetchImpl = (async (u: string) =>
      u.endsWith('/old') ? new Response(null, { status: 308, headers: { Location: 'https://example.com/new' } }) : upstream('ok')) as typeof fetch;
    const res = await call('https://example.com/old', { fetchImpl });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Final-Url')).toBe('https://example.com/new');
  });

  it('stops redirect loops', async () => {
    const fetchImpl = (async () => new Response(null, { status: 302, headers: { Location: 'https://example.com/loop' } })) as typeof fetch;
    expect((await call('https://example.com/loop', { fetchImpl })).status).toBe(508);
  });

  it('caps the size by Content-Length and while streaming', async () => {
    const big = (async () => upstream('x', { headers: { 'Content-Type': 'text/html', 'Content-Length': String(6 * 1024 * 1024) } })) as typeof fetch;
    expect((await call('https://example.com/', { fetchImpl: big })).status).toBe(413);
    const stream = (async () => upstream(new Uint8Array(2000))) as typeof fetch;
    const res = await call('https://example.com/', { fetchImpl: stream, maxBytes: 1000 });
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toMatch(/5 MB/);
  });

  it('times out slow sites', async () => {
    const slow = ((_u: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as typeof fetch;
    const res = await call('https://example.com/', { fetchImpl: slow, timeoutMs: 50 });
    expect(res.status).toBe(504);
  });

  it('rejects non-page content and upstream errors', async () => {
    const pdf = (async () => upstream('%PDF', { headers: { 'Content-Type': 'application/pdf' } })) as typeof fetch;
    expect((await call('https://example.com/x.pdf', { fetchImpl: pdf })).status).toBe(415);
    const missing = (async () => new Response('nope', { status: 404, statusText: 'Not Found' })) as typeof fetch;
    const res = await call('https://example.com/gone', { fetchImpl: missing });
    expect(res.status).toBe(502);
    expect(await errorOf(res)).toMatch(/404/);
  });
});
