import { Edit, Parser, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { compareEditedTree, position } from '../helpers/treeEdit.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

const Source = `type Primitive = bigint;
const value: bigint = 1n;
value as bigint<B>[] | B;
value satisfies bigint<B>[] | B;
value as bigint < B > C;
value satisfies bigint < B > C;
type Names = [bigint: string, bigint?: number, ...bigint: boolean[]];
type Function = (bigint: bigint) => bigint;
type Untyped = (bigint) => bigint;
type Optional = (bigint?) => bigint;
type Rest = (...bigint) => bigint;
function predicate(bigint: unknown): bigint is bigint { return true; }
function assertion(bigint: unknown): asserts bigint {}
const identity = (bigint: bigint) => bigint;
type Qualified = bigint.Member;
type Deep = ns.bigint;
type Generic = ns.bigint<string>;
type Query = typeof bigint<bigint>;
class C implements bigint<bigint> {}
interface I extends bigint {}
interface GenericI extends bigint<bigint> {}
`;

await Parser.init();

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves bigint primitive boundaries and identifier uses in ${dialect}`, async () => {
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    const tree = parser.parse(Source)!;
    try {
      check(tree, Source);
      expect(tree.rootNode.descendantsOfType('generic_type').map((node) => node.text)).toEqual([
        'ns.bigint<string>',
        'bigint<bigint>',
        'bigint<bigint>',
      ]);
      const start = Source.indexOf('as bigint') + 3;
      let source = Source;
      let incremental = tree.copy();
      try {
        for (const replacement of ['number', 'bigint']) {
          const nextSource = source.slice(0, start) + replacement + source.slice(start + 6);
          const next = compareEditedTree(
            parser,
            incremental,
            nextSource,
            new Edit({
              startIndex: start,
              oldEndIndex: start + 6,
              newEndIndex: start + replacement.length,
              startPosition: position(source, start),
              oldEndPosition: position(source, start + 6),
              newEndPosition: position(nextSource, start + replacement.length),
            }),
            (edited) => check(edited, nextSource)
          );
          incremental.delete();
          incremental = next;
          source = nextSource;
        }
      } finally {
        incremental.delete();
      }
    } finally {
      tree.delete();
      parser.delete();
    }
  });
}

function check(tree: Tree, source: string): void {
  const reference = ts.createSourceFile('bigint.ts', source, ts.ScriptTarget.Latest, true);
  expect(ts.transpileModule(source, { reportDiagnostics: true }).diagnostics).toEqual([]);
  expect(tree.rootNode.hasError, tree.rootNode.toString()).toBe(false);
  const expected: string[] = [];
  const primitives: number[][] = [];
  function visit(node: ts.Node): void {
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isBinaryExpression(node)) {
      expected.push(node.getText(reference));
    }
    if (node.kind === ts.SyntaxKind.BigIntKeyword) primitives.push([node.getStart(reference), node.end]);
    ts.forEachChild(node, visit);
  }
  visit(reference);
  expect(
    tree.rootNode
      .descendantsOfType('predefined_type')
      .filter((node) => node.text === 'bigint')
      .map((node) => [node.startIndex, node.endIndex])
  ).toEqual(primitives);
  expect(
    tree.rootNode
      .descendantsOfType(['as_expression', 'satisfies_expression', 'binary_expression'])
      .map((node) => node.text)
  ).toEqual(expected);
}
