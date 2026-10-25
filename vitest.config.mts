import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const growthTestFiles = [
  'test/unit/genericFunctionArguments.test.ts',
  'test/unit/performance.test.ts',
  'test/unit/untypedFunctionParameterNames.test.ts',
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          globals: true,
          include: ['test/unit/**/*.test.ts'],
          exclude: ['test/unit/browser/**', ...growthTestFiles],
          globalSetup: ['test/unit/globalSetup.ts'],
          sequence: { groupOrder: 1 },
        },
      },
      {
        test: {
          name: 'parser-growth',
          globals: true,
          include: growthTestFiles,
          globalSetup: ['test/unit/globalSetup.ts'],
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 2 },
        },
      },
      {
        test: {
          name: 'browser',
          globals: true,
          include: ['test/unit/browser/**/*.test.ts'],
          sequence: { groupOrder: 1 },
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
