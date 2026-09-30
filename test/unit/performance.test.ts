import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';

const Root = path.join(import.meta.dirname, '../..');
await Parser.init();

for (const grammar of ['typescript', 'tsx']) {
  // The Wasm builds are the ones the package ships.
  const wasmPath = path.join(Root, `tree-sitter-${grammar}.wasm`);
  const parser = new Parser();
  parser.setLanguage(await Language.load(wasmPath));

  describe(grammar, () => {
    // Only `bun run build/ci` rebuilds the Wasm build, so a check against a stale one would pass after a source
    // edit that brings the slowdown back.
    test('uses a Wasm build built from the current parser', () => {
      // src/parser.c is generated from the grammar, so an edit to the grammar alone also makes the Wasm build stale.
      const sources = [
        'common/defineGrammar.js',
        'common/scanner.h',
        `${grammar}/grammar.js`,
        `${grammar}/src/parser.c`,
        `${grammar}/src/scanner.c`,
      ].map((name) => fs.statSync(path.join(Root, name)).mtimeMs);
      expect(
        Math.max(...sources) > fs.statSync(wasmPath).mtimeMs,
        `common/ or ${grammar}/ changed after the Wasm build was built; run \`bun run build/ci\``
      ).toBe(false);
    });

    // Consumers parse files being edited, so recovering from many errors must stay linear: ten times the lines
    // must take about ten times as long (quadratic recovery would take a hundred times). The check compares the CPU
    // time of this process, since other test files run in parallel and slow down the wall-clock time of one parse
    // more than another's, and takes the fastest of a few parses.
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
