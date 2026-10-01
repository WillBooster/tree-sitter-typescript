import { describe, expect, test } from 'vitest';
import { Parser } from '@willbooster/web-tree-sitter';

import { loadCurrentWasmBuild } from './wasmBuild';

await Parser.init();

for (const grammar of ['typescript', 'tsx']) {
  const parser = new Parser();
  parser.setLanguage(await loadCurrentWasmBuild(grammar));

  describe(grammar, () => {
    // Consumers parse files being edited, so recovering from many errors must stay linear: ten times the lines
    // must take about ten times as long (quadratic recovery would take a hundred times). The check compares the CPU
    // time of this test file's process (see `pool` in vitest.config.mts), since other test files run in parallel and
    // slow down the wall-clock time of one parse more than another's, and takes the fastest of a few parses.
    // The seven parses take under 1 s here but over 5 s, Vitest's default timeout, on a busy CI runner.
    test('recovers from an error on each of 10,000 lines in linear time', { timeout: 60_000 }, () => {
      parseErrors(parser, 1000);
      const ratio = fastestParse(parser, 10_000) / fastestParse(parser, 1000);
      expect(ratio).toBeLessThan(30);
    });
  });
}

function fastestParse(parser: Parser, lines: number): number {
  return Math.min(...Array.from({ length: 3 }, () => parseErrors(parser, lines)));
}

function parseErrors(parser: Parser, lines: number): number {
  const source = '$ a\n'.repeat(lines);
  const start = process.cpuUsage();
  const tree = parser.parse(source);
  const { user, system } = process.cpuUsage(start);
  if (!tree) throw new Error('The parser returned no tree');
  const { hasError } = tree.rootNode;
  tree.delete();
  expect(hasError).toBe(true);
  return user + system;
}
