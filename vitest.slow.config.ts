import { defineConfig } from 'vitest/config';

/** Opt-in tests that download models and run real inference in Node: npm run test:slow */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/slow/**/*.test.ts'],
    testTimeout: 20 * 60 * 1000,
    hookTimeout: 20 * 60 * 1000,
    fileParallelism: false,
  },
});
