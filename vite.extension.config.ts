import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Builds the Firefox extension into dist-extension/ in two passes:
 *
 *   vite build -c vite.extension.config.ts                 background.js (ES module, with the scoring
 *                                                          worker and ONNX Runtime as assets),
 *                                                          options.html, manifest, icon, highlight.css
 *   vite build -c vite.extension.config.ts --mode content  content.js, one classic script: Firefox does
 *                                                          not load content scripts as modules
 */

const here = (p: string) => resolve(import.meta.dirname, p);
const outDir = here('dist-extension');

/** The app's icon is the extension's icon. */
function icon(): Plugin {
  return {
    name: 'rsvp-extension-icon',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'icon.svg', source: readFileSync(here('public/icon.svg')) });
    },
  };
}

export default defineConfig(({ mode }) => {
  if (mode === 'content') {
    return {
      publicDir: false,
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      build: {
        outDir,
        emptyOutDir: false,
        target: 'firefox142',
        minify: true,
        lib: {
          entry: here('src/extension/content.ts'),
          formats: ['iife'],
          name: 'rsvpReaderContent',
          fileName: () => 'content.js',
        },
      },
    };
  }
  return {
    root: here('extension'),
    base: './',
    // See src/surprisal/worker.ts: load ONNX Runtime's WASM from the extension, never a CDN.
    define: { 'import.meta.env.VITE_ORT_LOCAL_WASM': JSON.stringify(true) },
    publicDir: here('extension/public'),
    plugins: [react(), icon()],
    worker: { format: 'es' },
    build: {
      outDir,
      emptyOutDir: true,
      target: 'firefox142',
      rollupOptions: {
        input: {
          background: here('src/extension/background.ts'),
          options: here('extension/options.html'),
        },
        output: {
          entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
        },
      },
    },
  };
});
