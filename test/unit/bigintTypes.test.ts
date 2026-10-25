import { Edit, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
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

const QuerySource = `function bigint<T>(value: T) { return value; }
namespace bigint { export const A = { B: 1n }; }
type Root = (typeof bigint);
type Chain = (typeof bigint.A.B);
type Instantiated = (typeof bigint<string>);
type Return = (value: unknown) => (typeof bigint);
`;

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves bigint queries and keyword-qualified heritage in ${dialect}`, async () => {
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser().setLanguage(language);
    const query = new Query(language, '(type_query) @query');
    try {
      for (const source of [
        'const bigint = 1n; type T = (typeof bigint);',
        QuerySource,
        ...['keyof', 'readonly', 'unique', 'infer'].map(
          (name) =>
            `class Direct implements ${name}.bigint {}
class Generic implements ${name}.bigint<string> {}`
        ),
      ]) {
        const tree = parser.parse(source)!;
        try {
          check(tree, source, 'bigint.ts', query);
        } finally {
          tree.delete();
        }
      }
      let source = QuerySource;
      let tree = parser.parse(source)!;
      const start = source.indexOf('type Root = (typeof bigint') + 'type Root = (typeof '.length;
      try {
        for (const replacement of ['Widget', 'bigint']) {
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
            (edited) => check(edited, nextSource, 'bigint.ts', query)
          );
          tree.delete();
          tree = next;
          source = nextSource;
        }
      } finally {
        tree.delete();
      }
    } finally {
      query.delete();
      parser.delete();
    }
  });
}

test('preserves bigint JSX names and query captures through edits', async () => {
  const language = await loadCurrentWasmBuild('tsx');
  const parser = new Parser().setLanguage(language);
  const query = new Query(
    language,
    `[
    (jsx_opening_element name: (_) @name)
    (jsx_closing_element name: (_) @name)
    (jsx_self_closing_element name: (_) @name)
  ]`
  );
  let source = `const elements = [<bigint/>, <bigint a="1"/>, <bigint></bigint>,
    <bigint:x/>, <x:bigint/>, <bigint.A/>, <A.bigint.B/>];`;
  let tree = parser.parse(source)!;
  const start = source.indexOf('<bigint') + 1;
  try {
    checkJsx(tree, source);
    for (const replacement of ['number', 'bigint']) {
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
        (edited) => checkJsx(edited, nextSource)
      );
      tree.delete();
      tree = next;
      source = nextSource;
    }
  } finally {
    tree.delete();
    query.delete();
    parser.delete();
  }

  function checkJsx(current: Tree, text: string): void {
    check(current, text, 'bigint.tsx');
    const reference = ts.createSourceFile('bigint.tsx', text, ts.ScriptTarget.Latest, true);
    const names: string[] = [];
    function visit(node: ts.Node): void {
      if (ts.isJsxOpeningElement(node) || ts.isJsxClosingElement(node) || ts.isJsxSelfClosingElement(node)) {
        names.push(node.tagName.getText(reference));
      }
      ts.forEachChild(node, visit);
    }
    visit(reference);
    expect(query.captures(current.rootNode).map((capture) => capture.node.text)).toEqual(names);
  }
});

function check(tree: Tree, source: string, fileName = 'bigint.ts', query?: Query): void {
  const reference = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  expect(ts.transpileModule(source, { reportDiagnostics: true, fileName }).diagnostics).toEqual([]);
  expect(tree.rootNode.hasError, tree.rootNode.toString()).toBe(false);
  const expected: string[] = [];
  const primitives: number[][] = [];
  const qualifiedNames: number[][] = [];
  const typeQueries: number[][] = [];
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
    if (ts.isTypeQueryNode(node)) typeQueries.push([node.getStart(reference), node.end]);
    if (node.kind === ts.SyntaxKind.BigIntKeyword) primitives.push([node.getStart(reference), node.end]);
    ts.forEachChild(node, visit);
  }
  visit(reference);
  expect(tree.rootNode.descendantsOfType('type_query').map((node) => [node.startIndex, node.endIndex])).toEqual(
    typeQueries
  );
  if (query)
    expect(query.captures(tree.rootNode).map(({ node }) => [node.startIndex, node.endIndex])).toEqual(typeQueries);
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
