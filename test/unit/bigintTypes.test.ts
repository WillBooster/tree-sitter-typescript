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
type Destructured = ([bigint]) => bigint;
type AnnotatedDestructured = ([bigint]: bigint[]) => bigint;
type NestedDestructured = ([[bigint]]) => bigint;
type RestDestructured = ([...bigint]) => bigint;
type ObjectDestructured = ({ bigint }: X) => bigint;
type Tuple = [bigint];
type ParenthesizedTuple = ([bigint]);
type TupleFunction = ([bigint]) => [bigint];
const arrayValue = [bigint];
const [bigint] = arrayValue;
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

const QualifiedSource = `namespace A { export namespace bigint { export interface B<T = number> {} } }
namespace bigint { export namespace A { export interface B<T = number> {} } }
type Box<T> = T[];
let nested: A.bigint.B;
let root: bigint.A.B;
let generic: A.bigint.B<string>;
let rootGeneric: bigint.A.B<string>;
let array: A.bigint.B[];
let list: Box<A.bigint.B>;
class Nested implements A.bigint.B {}
class Root implements bigint.A.B {}
interface Extended extends A.bigint.B {}
interface RootExtended extends bigint.A.B {}
type X = { a: string };
type Mapped = { [bigint in keyof X]: 1 };
type Modified = { -readonly [bigint in keyof X as bigint]?: bigint };
`;

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves qualified bigint names and mapped binders through edits in ${dialect}`, async () => {
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    let source = QualifiedSource;
    let tree = parser.parse(source)!;
    try {
      check(tree, source);
      expect(
        tree.rootNode.descendantsOfType('mapped_type_clause').map((node) => node.childForFieldName('name')?.text)
      ).toEqual(['bigint', 'bigint']);
      const start = source.indexOf('let nested: A.bigint') + 'let nested: A.'.length;
      for (const replacement of ['Member', 'bigint']) {
        const nextSource = source.slice(0, start) + replacement + source.slice(start + 6);
        const next = compareEditedTree(
          parser,
          tree,
          nextSource,
          new Edit({
            startIndex: start,
            oldEndIndex: start + 6,
            newEndIndex: start + 6,
            startPosition: position(source, start),
            oldEndPosition: position(source, start + 6),
            newEndPosition: position(nextSource, start + 6),
          }),
          (edited) => check(edited, nextSource)
        );
        tree.delete();
        tree = next;
        source = nextSource;
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
  const qualifiedNames: number[][] = [];
  function visit(node: ts.Node): void {
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isBinaryExpression(node)) {
      expected.push(node.getText(reference));
    }
    if (ts.isTypeReferenceNode(node) && ts.isQualifiedName(node.typeName)) {
      qualifiedNames.push([node.typeName.getStart(reference), node.typeName.end]);
    }
    if (ts.isExpressionWithTypeArguments(node) && ts.isPropertyAccessExpression(node.expression)) {
      qualifiedNames.push([node.expression.getStart(reference), node.expression.end]);
    }
    if (node.kind === ts.SyntaxKind.BigIntKeyword) primitives.push([node.getStart(reference), node.end]);
    ts.forEachChild(node, visit);
  }
  visit(reference);
  expect(
    tree.rootNode.descendantsOfType('nested_type_identifier').map((node) => [node.startIndex, node.endIndex])
  ).toEqual(qualifiedNames);
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
