import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// tsconfig.json declares the `vitest/globals` types, so both projects provide the globals at run time for the type check
// to agree with them.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          globals: true,
          include: ['test/unit/**/*.test.ts'],
          exclude: ['test/unit/browser/**'],
          globalSetup: ['test/unit/globalSetup.ts'],
        },
      },
      {
        test: {
          name: 'browser',
          globals: true,
          include: ['test/unit/browser/**/*.test.ts'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
