import { defineConfig } from 'vitest/config';

// DB-backed test files truncate the same test database, so files run one at a time.
export default defineConfig({ test: { fileParallelism: false } });
