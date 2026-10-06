import fs from 'node:fs';
import path from 'node:path';

import { Edit, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { compareEditedTree, position } from '../helpers/treeEdit.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

const Source = fs.readFileSync(path.join(import.meta.dirname, '../fixtures/predefinedAssertionNames.ts'), 'utf8');

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves ${dialect} predefined assertion names through identifier edits`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser().setLanguage(language);
    const queries: Query[] = [];
    let tree: Tree | undefined;
    let source = Source;
    try {
      const query = new Query(language, '(asserts . (identifier) @name)');
      queries.push(query);
      const predicates = new Query(language, '(asserts (type_predicate name: (identifier) @name type: (_) @type))');
      queries.push(predicates);
      tree = parser.parse(source)!;
      check(tree);
      for (const word of ['any', 'number', 'boolean', 'string', 'symbol', 'unknown', 'never', 'object']) {
        const start = source.indexOf(`asserts ${word}`) + 'asserts '.length;
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
      }
      expect(source).toBe(Source);
      function check(current: Tree, text = source): void {
        const reference = ts.createSourceFile('assertions.ts', text, ts.ScriptTarget.Latest, true);
        const names: [string, number, number][] = [];
        const predicateRoles: [string, string, number, number][] = [];
        const visit = (node: ts.Node): void => {
          if (ts.isTypePredicateNode(node) && node.assertsModifier && ts.isIdentifier(node.parameterName)) {
            const name = node.parameterName;
            if (node.type) {
              predicateRoles.push(['name', name.getText(reference), name.getStart(reference), name.getEnd()]);
              predicateRoles.push([
                'type',
                node.type.getText(reference),
                node.type.getStart(reference),
                node.type.getEnd(),
              ]);
            } else names.push([name.getText(reference), name.getStart(reference), name.getEnd()]);
          }
          ts.forEachChild(node, visit);
        };
        visit(reference);
        expect(current.rootNode.hasError).toBe(false);
        expect(query.captures(current.rootNode).map(({ node }) => [node.text, node.startIndex, node.endIndex])).toEqual(
          names
        );
        expect(
          predicates
            .captures(current.rootNode)
            .map(({ name, node }) => [name, node.text, node.startIndex, node.endIndex])
        ).toEqual(predicateRoles);
      }
    } finally {
      tree?.delete();
      for (const query of queries) query.delete();
      parser.delete();
    }
  });
}
