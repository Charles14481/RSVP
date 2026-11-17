import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleFetch } from './fetchProxy';
import { nodeFetch } from './nodeFetch';

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    switch (req.url) {
      case '/page':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': ['a=1', 'b=2'] });
        res.end(`<html><body>${req.headers['accept-encoding']}</body></html>`);
        return;
      case '/redirect':
        res.writeHead(302, { Location: '/page' });
        res.end('moved');
        return;
      case '/big-then-close':
        // Streams far more than a client reads, then hangs up: the undici crash scenario.
        res.writeHead(404, { 'Content-Type': 'text/html' });
        for (let i = 0; i < 64; i++) res.write('x'.repeat(64 * 1024));
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      case '/reset-mid-body':
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': '100000' });
        res.write('partial');
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      case '/slow':
        setTimeout(() => res.end('late'), 2000);
        return;
      default:
        res.writeHead(204);
        res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('nodeFetch', () => {
  it('returns status, headers and body, asking for an uncompressed response', async () => {
    const res = await nodeFetch(`${base}/page`, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toContain('identity');
  });

  it('does not follow redirects', async () => {
    const res = await nodeFetch(`${base}/redirect`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/page');
    await res.body?.cancel();
  });

  it('gives a null body for 204', async () => {
    const res = await nodeFetch(`${base}/empty`);
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });

  it('survives cancelling an unread body while the server hangs up', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await nodeFetch(`${base}/big-then-close`);
      expect(res.status).toBe(404);
      void res.body?.cancel();
    }
    await new Promise((r) => setTimeout(r, 200)); // let late socket events fire
  });

  it('errors the body stream when the connection resets mid-body', async () => {
    const res = await nodeFetch(`${base}/reset-mid-body`);
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it('rejects on abort', async () => {
    await expect(nodeFetch(`${base}/slow`, { signal: AbortSignal.timeout(50) })).rejects.toThrow();
  });

  it('rejects when nothing listens', async () => {
    await expect(nodeFetch('http://127.0.0.1:1/')).rejects.toThrow();
  });

  it('works as the proxy fetch for a cancelled error response', async () => {
    const res = await handleFetch(new Request(`http://localhost/api/fetch?url=${encodeURIComponent('https://example.com/')}`), {
      allowedOrigins: [],
      allowMissingOrigin: true,
      resolve: async () => ['93.184.215.14'],
      // The proxy refuses loopback targets, so route its public-looking request to the local server.
      fetchImpl: ((_u: string, init?: RequestInit) => nodeFetch(`${base}/big-then-close`, init)) as typeof fetch,
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'The site answered 404 Not Found.' });
  });
});
