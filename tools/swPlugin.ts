import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Emits sw.js at build time with the full list of built files to precache, so
 * the app opens and reads offline. Model weights are not part of it:
 * Transformers.js keeps those in Cache Storage itself.
 */
export function serviceWorkerPlugin(): Plugin {
  let publicDir = '';
  return {
    name: 'surprisal-reader-sw',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      publicDir = config.publicDir;
    },
    generateBundle(_options, bundle) {
      const built = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const fromPublic = publicDir ? listFiles(publicDir).map((f) => relative(publicDir, f).replace(/\\/g, '/')) : [];
      const files = [...new Set([...built, ...fromPublic])].filter((f) => f !== 'sw.js').sort();
      const version = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: serviceWorkerSource(version, ['./', ...files.map((f) => `./${f}`)]) });
    },
  };
}

function listFiles(dir: string): string[] {
  let out: string[] = [];
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      out = statSync(p).isDirectory() ? out.concat(listFiles(p)) : out.concat(p);
    }
  } catch {
    // no public dir
  }
  return out;
}

function serviceWorkerSource(version: string, precache: string[]): string {
  return `// Generated at build time by tools/swPlugin.ts.
const CACHE = 'surprisal-reader-shell-${version}';
const PRECACHE = ${JSON.stringify(precache, null, 2)};
// Servers often send "Vary: Origin" or "Vary: Accept-Encoding". Module scripts are requested with an
// Origin header and the precache requests are not, so a Vary-respecting match would miss every
// script offline. These files are same-origin and content-hashed, so Vary carries no information here.
const MATCH = { ignoreSearch: true, ignoreVary: true };

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('surprisal-reader-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Only the app itself: models (Hugging Face) are cached by Transformers.js, and the fetch proxy must stay live.
  if (url.origin !== self.location.origin || url.pathname.includes('/api/')) return;

  if (req.mode === 'navigate') {
    // Network first so a new deployment is picked up; the cached shell when offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put('./', res.clone()));
          return res;
        })
        .catch(() => caches.match('./', MATCH)),
    );
    return;
  }

  // Built files have content hashes in their names: cache first.
  event.respondWith(caches.match(req, MATCH).then((hit) => hit || fetch(req)));
});
`;
}
