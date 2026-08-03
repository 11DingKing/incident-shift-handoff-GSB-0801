import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Concurrency tests share one Postgres database; run files serially and
    // reset state between tests to keep them deterministic.
    fileParallelism: false,
    sequence: { concurrent: false },
    hookTimeout: 30000,
    testTimeout: 30000,
    globals: false,
  },
});
