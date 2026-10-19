import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The AI evaluation set's offline checks: npm run eval:offline (also runs the Python half with pytest).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: { include: ['**/*.test.ts'], testTimeout: 60_000 },
});
