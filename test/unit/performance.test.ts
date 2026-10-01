import { describe, expect, test } from 'vitest';
import { Parser } from '@willbooster/web-tree-sitter';

import { loadCurrentWasmBuild } from './wasmBuild';

await Parser.init();

for (const grammar of ['typescript', 'tsx']) {
  const parser = new Parser();
  parser.setLanguage(await loadCurrentWasmBuild(grammar));

  describe(grammar, () => {
    // Consumers parse files being edited, so recovering from many errors must stay linear: ten times the lines take
    // about ten times as long, against a hundred times for quadratic recovery. The parses are timed in the CPU time of
    // the thread that runs them: wall-clock time is inflated unevenly by the test files running alongside, and the
    // process's CPU time also counts the engine's background threads, which compile the Wasm build and collect garbage
    // during the parses. 2,000 and 20,000 lines are measured after warm-up parses and in alternation, each keeping its
    // fastest run, which gives 10.0 to 10.2 locally; 18 leaves a margin over that and fails for growth faster than about
    // n^1.25.
    // The parses take a few seconds on a busy CI runner, more than Vitest's default timeout of 5 s.
    test('recovers from an error on each line in linear time', { timeout: 60_000 }, () => {
      const small = '$ a\n'.repeat(2000);
      const large = '$ a\n'.repeat(20_000);
      parseCpuTime(parser, large);
      parseCpuTime(parser, large);
      let smallFastest = Infinity;
      let largeFastest = Infinity;
      for (let run = 0; run < 5; run++) {
        smallFastest = Math.min(smallFastest, parseCpuTime(parser, small));
        largeFastest = Math.min(largeFastest, parseCpuTime(parser, large));
      }
      expect(largeFastest / smallFastest).toBeLessThan(18);
    });
  });
}

function parseCpuTime(parser: Parser, source: string): number {
  const start = process.threadCpuUsage();
  const tree = parser.parse(source);
  const { user, system } = process.threadCpuUsage(start);
  if (!tree) throw new Error('The parser returned no tree');
  const { hasError } = tree.rootNode;
  tree.delete();
  expect(hasError).toBe(true);
  return user + system;
}
