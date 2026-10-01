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
          // test/unit/performance.test.ts times parses in process CPU time, which counts only that test file while
          // each worker is a process of its own; threads would share it with the test files running alongside.
          pool: 'forks',
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
