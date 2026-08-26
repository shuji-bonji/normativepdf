import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // docs/examples/*.mts import 'normativepdf' the way a consumer would;
    // in this repository that name resolves to the source entry point.
    alias: {
      normativepdf: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
