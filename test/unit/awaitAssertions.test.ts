import { Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

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
  test(`retains ${dialect} awaited assertion operands`, async () => {
    await Parser.init();
    const parser = new Parser();
    let query: Query | undefined;
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
      for (const source of [Source, Source.replace('as number', 'satisfies number')]) {
        const tree = parser.parse(source)!;
        try {
          check(tree, source);
        } finally {
          tree.delete();
        }
      }
    } finally {
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
