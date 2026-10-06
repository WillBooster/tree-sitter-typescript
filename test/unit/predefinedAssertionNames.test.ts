import fs from 'node:fs';
import path from 'node:path';

import { Edit, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import treeSitterJson from '../../tree-sitter.json';
import { compareEditedTree, position } from '../helpers/treeEdit.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

const Source = fs.readFileSync(path.join(import.meta.dirname, '../fixtures/predefinedAssertionNames.ts'), 'utf8');

describe.each(['typescript', 'tsx'])('%s assertion names', (dialect) => {
  let language: Awaited<ReturnType<typeof loadCurrentWasmBuild>>;
  let query: Query;
  let predicates: Query;
  const queries: Query[] = [];
  beforeAll(async () => {
    await Parser.init();
    language = await loadCurrentWasmBuild(dialect);
    query = new Query(language, '(asserts . (identifier) @name)');
    queries.push(query);
    predicates = new Query(language, '(type_predicate name: (identifier) @name type: (_) @type)');
    queries.push(predicates);
  }, 30_000);
  afterAll(() => {
    for (const resource of queries) resource.delete();
  });
  test.each(['any', 'number', 'boolean', 'string', 'symbol', 'unknown', 'never', 'object', 'unique'])(
    'preserves %s through identifier edits',
    (word) => {
      const parser = new Parser().setLanguage(language);
      let tree: Tree | undefined;
      let source = Source;
      try {
        tree = parser.parse(source)!;
        check(tree);
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
        expect(source).toBe(Source);
        function check(current: Tree, text = source): void {
          const reference = ts.createSourceFile('assertions.ts', text, ts.ScriptTarget.Latest, true);
          const names: [string, number, number][] = [];
          const predicateRoles: [string, string, number, number][] = [];
          const visit = (node: ts.Node): void => {
            if (ts.isTypePredicateNode(node) && ts.isIdentifier(node.parameterName)) {
              const name = node.parameterName;
              if (node.type) {
                predicateRoles.push(['name', name.getText(reference), name.getStart(reference), name.getEnd()]);
                predicateRoles.push([
                  'type',
                  node.type.getText(reference),
                  node.type.getStart(reference),
                  node.type.getEnd(),
                ]);
              } else if (node.assertsModifier)
                names.push([name.getText(reference), name.getStart(reference), name.getEnd()]);
            }
            ts.forEachChild(node, visit);
          };
          visit(reference);
          expect(current.rootNode.hasError).toBe(false);
          expect(
            query.captures(current.rootNode).map(({ node }) => [node.text, node.startIndex, node.endIndex])
          ).toEqual(names);
          expect(
            predicates
              .captures(current.rootNode)
              .map(({ name, node }) => [name, node.text, node.startIndex, node.endIndex])
          ).toEqual(predicateRoles);
        }
      } finally {
        tree?.delete();
        parser.delete();
      }
    }
  );
});

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves ${dialect} canonical assertion prefixes through malformed array-tail edits`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser().setLanguage(language);
    const queries: Query[] = [];
    let tree: Tree | undefined;
    try {
      const grammar = treeSitterJson.grammars.find((entry) => entry.name === dialect)!;
      for (const files of [grammar.highlights, grammar.tags, grammar.locals, grammar.injections]) {
        const querySource = [files]
          .flat()
          .map((file) => fs.readFileSync(path.join(import.meta.dirname, '../..', file), 'utf8'))
          .join('\n');
        queries.push(new Query(language, querySource));
      }
      for (const word of ['any', 'number', 'boolean', 'string', 'symbol', 'unknown', 'never', 'object', 'unique']) {
        let source = `declare function f(value: unknown): asserts ${word};\nconst sentinel = 1;\n`;
        tree = parser.parse(source)!;
        expect(tree.rootNode.hasError).toBe(false);
        const start = source.indexOf(';');
        for (const [before, after] of [
          ['', '[], number'],
          ['[], number', ''],
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
              for (const query of queries) {
                const captures = (current: Tree): unknown[] =>
                  query
                    .captures(current.rootNode)
                    .map(({ name, node }) => [
                      name,
                      node.type,
                      node.text,
                      node.startIndex,
                      node.endIndex,
                      node.startPosition,
                      node.endPosition,
                    ]);
                expect(captures(incremental)).toEqual(captures(fresh));
              }
              for (const current of [incremental, fresh]) {
                expect(current.rootNode.hasError).toBe(after !== '');
                const assertion = current.rootNode.descendantsOfType('asserts').find((node) => node.isNamed)!;
                expect(assertion.namedChildren[0]!.type).toBe('identifier');
                expect(assertion.namedChildren[0]!.text).toBe(word);
                expect(current.rootNode.descendantsOfType('expression_statement').map((node) => node.text)).toEqual(
                  after ? ['[], number;'] : []
                );
                expect(current.rootNode.namedChildren.at(-1)!.text).toBe('const sentinel = 1;');
              }
            },
            true
          );
          previous.delete();
          source = next;
        }
        tree.delete();
        tree = undefined;
      }
    } finally {
      tree?.delete();
      for (const query of queries) query.delete();
      parser.delete();
    }
  });
}
