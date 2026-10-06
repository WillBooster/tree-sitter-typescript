import { Edit, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { compareEditedTree, position } from '../helpers/treeEdit.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

const Source = `async function resolve(value: Promise<number>) {
  const assertion = await value as number;
  const checked = await value satisfies number;
  const grouped = (await value) as number;
  const nested = await (value as Promise<number>);
  const combined = await value + 1;
  const call = await Promise.resolve(1) as number;
  const array = await Promise.resolve([1]) as readonly number[];
  return { assertion, checked, grouped, nested, combined, call, array };
}
const make = async () => await Promise.resolve(1) as number;
`;

for (const dialect of ['typescript', 'tsx']) {
  test(`retains ${dialect} awaited assertion operands through edits`, async () => {
    await Parser.init();
    const parser = new Parser();
    let query: Query | undefined;
    let tree: Tree | undefined;
    let source = Source;
    try {
      const language = await loadCurrentWasmBuild(dialect);
      parser.setLanguage(language);
      query = new Query(
        language,
        `
        (as_expression . (_) @operand) @operator
        (satisfies_expression . (_) @operand) @operator
        (await_expression . (_) @operand) @operator
      `
      );
      tree = parser.parse(source)!;
      check(tree, source);
      const start = source.indexOf('as number');
      for (const [before, after] of [
        ['as', 'satisfies'],
        ['satisfies', 'as'],
      ] as const) {
        const next = source.slice(0, start) + after + source.slice(start + before.length);
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex: start,
            oldEndIndex: start + before.length,
            newEndIndex: start + after.length,
            startPosition: position(source, start),
            oldEndPosition: position(source, start + before.length),
            newEndPosition: position(next, start + after.length),
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
    } finally {
      tree?.delete();
      query?.delete();
      parser.delete();
    }

    function check(current: Tree, text: string): void {
      const reference = ts.createSourceFile(
        `await.${dialect === 'tsx' ? 'tsx' : 'ts'}`,
        text,
        ts.ScriptTarget.Latest,
        true,
        dialect === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      );
      const expected: [string, number, number, string, number, number][] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isAwaitExpression(node)) {
          const kind = ts.isAsExpression(node)
            ? 'as_expression'
            : ts.isSatisfiesExpression(node)
              ? 'satisfies_expression'
              : 'await_expression';
          expected.push([
            kind,
            node.getStart(reference),
            node.getEnd(),
            node.expression.getText(reference),
            node.expression.getStart(reference),
            node.expression.getEnd(),
          ]);
        }
        ts.forEachChild(node, visit);
      };
      visit(reference);
      expect(current.rootNode.hasError).toBe(false);
      expect(
        query!.matches(current.rootNode).map(({ captures }) => {
          const operator = captures.find(({ name }) => name === 'operator')!.node;
          const operand = captures.find(({ name }) => name === 'operand')!.node;
          return [
            operator.type,
            operator.startIndex,
            operator.endIndex,
            operand.text,
            operand.startIndex,
            operand.endIndex,
          ];
        })
      ).toEqual(expected);
    }
  });
}
