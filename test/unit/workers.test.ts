import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestHarness, type TestHarness } from 'wrangler';

import { expectedTrees } from '../fixtures/expectedTrees.js';

// The same Worker with and without Node.js compatibility, since the package must run in both.
const configs = {
  'tree-sitter-typescript-test': 'wrangler.jsonc',
  'tree-sitter-typescript-test-no-nodejs-compat': 'wrangler.no-nodejs-compat.jsonc',
};

let server: TestHarness | undefined;

beforeAll(async () => {
  server = createTestHarness({
    workers: Object.values(configs).map((config) => ({
      configPath: path.join(import.meta.dirname, '../fixtures/worker', config),
    })),
  });
  await server.listen();
}, 120_000);

afterAll(async () => {
  await server?.close();
});

describe.each(Object.keys(configs))('in Cloudflare Workers (%s)', (name) => {
  test.each(Object.entries(expectedTrees))('parses with the %s grammar', async (grammar, { source, tree }) => {
    const response = await server!.getWorker(name).fetch(`http://localhost/${grammar}`, {
      method: 'POST',
      body: source,
    });
    expect(await response.text()).toBe(tree);
  });
});
