// vitest.config.js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Exclude Playwright e2e specs (run via `npm run test:e2e`) from the
    // Vitest unit suite, and ignore the build output directory.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
    globalSetup: './tests/vitestGlobalSetup.js',
  },
});