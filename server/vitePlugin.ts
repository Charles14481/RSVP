import { lookup } from 'node:dns/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import { handleFetch } from './fetchProxy.ts';
import { nodeFetch } from './nodeFetch.ts';

/** Resolve all addresses so DNS answers pointing at private networks are refused. */
async function resolve(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);
}

function middleware(): Connect.NextHandleFunction {
  return (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    const host = req.headers.host ?? 'localhost';
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (url.pathname !== '/api/fetch') return next();
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const request = new Request(url, { method: req.method, headers });
    handleFetch(request, {
      // Same-origin GETs carry no Origin header; cross-origin callers must be this server.
      allowedOrigins: [`http://${host}`, `https://${host}`],
      allowMissingOrigin: true,
      resolve,
      // Not the global fetch: see nodeFetch.ts for the undici crash this avoids.
      fetchImpl: nodeFetch,
    })
      .then(async (response) => {
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        res.end(Buffer.from(await response.arrayBuffer()));
      })
      .catch(next);
  };
}

/** Serves GET /api/fetch from the Vite dev and preview servers. */
export function fetchProxyPlugin(): Plugin {
  return {
    name: 'surprisal-reader-fetch-proxy',
    configureServer(server) {
      server.middlewares.use(middleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware());
    },
  };
}
