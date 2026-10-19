import { defineConfig } from 'vitest/config';

// Integration suites share one test database and Redis db, so files run one at a time.
export default defineConfig({ test: { fileParallelism: false, testTimeout: 20_000, hookTimeout: 30_000 } });
