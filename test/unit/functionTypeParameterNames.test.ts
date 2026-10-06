import fs from 'node:fs';
import path from 'node:path';

import { Edit, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { compareEditedTree, position } from '../helpers/treeEdit.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

const Source = fs.readFileSync(path.join(import.meta.dirname, '../fixtures/functionTypeParameterNames.ts'), 'utf8');

describe.each(['typescript', 'tsx'])('%s function-type parameter names', (dialect) => {
  let language: Awaited<ReturnType<typeof loadCurrentWasmBuild>>;
  let query: Query | undefined;
  beforeAll(async () => {
    await Parser.init();
    language = await loadCurrentWasmBuild(dialect);
    query = new Query(
      language,
      `
      [(required_parameter pattern: (identifier) @name)
       (optional_parameter pattern: (identifier) @name)]
      [(required_parameter type: (type_annotation (_) @type))
       (optional_parameter type: (type_annotation (_) @type))]
    `
    );
  }, 30_000);
  afterAll(() => query?.delete());
  test.each([
    '(unknown: unknown)',
    '(never: never)',
    '(unique: unknown)',
    '(unknown?: number',
    ', never?: string) => string',
  ])('preserves %s name and type through edits', (marker) => {
    const parser = new Parser().setLanguage(language);
    let tree: Tree | undefined;
    let source = Source;
    try {
      tree = parser.parse(source)!;
      check(tree, source);
      const word = marker.startsWith('(unique:') ? 'unique' : marker.includes('unknown') ? 'unknown' : 'never';
      const markerStart = source.indexOf(marker);
      expect(markerStart).toBeGreaterThanOrEqual(0);
      const start = markerStart + marker.indexOf(word);
      for (const [before, after] of [
        [word, 'parameter'],
        ['parameter', word],
      ]) {
        const next = source.slice(0, start) + after + source.slice(start + before!.length);
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex: start,
            oldEndIndex: start + before!.length,
            newEndIndex: start + after!.length,
            startPosition: position(source, start),
            oldEndPosition: position(source, start + before!.length),
            newEndPosition: position(next, start + after!.length),
          }),
          (incremental, fresh) => {
            check(incremental, next);
            check(fresh, next);
          }
        );
        previous.delete();
        source = next;
      }
      expect(source).toBe(Source);
      function check(current: Tree, text: string): void {
        const reference = ts.createSourceFile('parameters.ts', text, ts.ScriptTarget.Latest, true);
        const expected: [string, string, number, number][] = [];
        const visit = (node: ts.Node): void => {
          if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
            expected.push(['name', node.name.getText(reference), node.name.getStart(reference), node.name.getEnd()]);
            if (node.type)
              expected.push(['type', node.type.getText(reference), node.type.getStart(reference), node.type.getEnd()]);
          }
          ts.forEachChild(node, visit);
        };
        visit(reference);
        expect(current.rootNode.hasError).toBe(false);
        expect(
          query!.captures(current.rootNode).map(({ name, node }) => [name, node.text, node.startIndex, node.endIndex])
        ).toEqual(expected);
      }
    } finally {
      tree?.delete();
      parser.delete();
    }
  });
});
