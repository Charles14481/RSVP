import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fetchProxyPlugin } from './server/vitePlugin.ts';
import { serviceWorkerPlugin } from './tools/swPlugin.ts';

/**
 * Cross-origin isolation lets ONNX Runtime use multithreaded WASM
 * (SharedArrayBuffer). Deployments should send the same two headers.
 */
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: './',
  plugins: [react(), fetchProxyPlugin(), serviceWorkerPlugin()],
  worker: { format: 'es' },
  server: { headers: isolation },
  preview: { headers: isolation },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'server/**/*.test.ts'],
    exclude: ['test/slow/**', 'node_modules/**'],
  },
});
