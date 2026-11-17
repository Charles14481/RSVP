import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * The small part of fetch the proxy needs, built on node:http(s) instead of
 * Node's bundled undici. undici can throw an uncatchable assertion
 * (`assert(!this.paused)` in Parser.finish) when a response body is cancelled
 * while the server closes the connection, which takes the whole dev server
 * down. Here every failure arrives as an ordinary 'error' event and becomes a
 * rejected promise or an errored body stream.
 *
 * Redirects are never followed (the caller checks each hop) and responses are
 * requested uncompressed.
 */
export const nodeFetch = ((input: string | URL, init: RequestInit = {}) => {
  const url = new URL(input.toString());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return Promise.reject(new TypeError(`Unsupported protocol ${url.protocol}`));
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const headers: Record<string, string> = { 'Accept-Encoding': 'identity' };
  new Headers(init.headers).forEach((value, key) => (headers[key] = value));

  return new Promise<Response>((resolve, reject) => {
    const req = request(url, { method: 'GET', headers, signal: init.signal ?? undefined }, (res: IncomingMessage) => {
      const out = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
          try {
            out.append(key, v);
          } catch {
            // a header value fetch would reject; the proxy does not need it
          }
        }
      }
      const status = res.statusCode ?? 502;
      if (NULL_BODY.has(status)) res.resume();
      const body = NULL_BODY.has(status) ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
      try {
        resolve(new Response(body, { status, statusText: res.statusMessage ?? '', headers: out }));
      } catch (e) {
        res.destroy();
        reject(e);
      }
    });
    req.on('error', reject);
    req.end();
  });
}) as typeof fetch;
