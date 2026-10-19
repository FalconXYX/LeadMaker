import { defineConfig } from 'vitest/config';

// The Redis-backed suites (test:db) share one Redis db, so files run one at a time.
export default defineConfig({ test: { fileParallelism: false, testTimeout: 20_000 } });
