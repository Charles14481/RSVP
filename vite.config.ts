import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Cross-origin isolation lets ONNX Runtime use multithreaded WASM
 * (SharedArrayBuffer). Deployments should send the same two headers.
 */
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  server: { headers: isolation },
  preview: { headers: isolation },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['test/slow/**', 'node_modules/**'],
  },
});
