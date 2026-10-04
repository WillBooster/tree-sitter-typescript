import { Edit, Parser, Query, type Node, type Point, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { loadCurrentWasmBuild } from './wasmBuild.js';

type OperandCapture = readonly [number, string, number, number];

const Source = `type B = number;
type C = string;
type Branch = B | readonly B[] | C;
type Intersection = readonly B[] & readonly C[];
type Keys = keyof readonly B[];
type KeyUnion = keyof B[] | C;
type KeyReadonlyUnion = keyof readonly B[] | C;
type KeyIntersection = keyof readonly B[] & C;
type Nested = readonly B[][];
type Tuple = readonly [first: B, second: C];
type TupleArray = readonly [B, C][];
type Conditional = readonly B[] extends readonly unknown[] ? B : C;
type Parenthesized = (readonly B[])[];
interface Registry { branch: Branch; intersection: Intersection; keys: Keys; nested: Nested; tuple: Tuple; tupleArray: TupleArray; conditional: Conditional; parenthesized: Parenthesized; }
`;

for (const dialect of ['typescript', 'tsx']) {
  test(`retains ${dialect} type-operator operands through operator edits`, async () => {
    await Parser.init();
    const parser = new Parser();
    let query: Query | undefined;
    let aliasQuery: Query | undefined;
    let tree: Tree | undefined;
    let source = Source;
    try {
      const language = await loadCurrentWasmBuild(dialect);
      parser.setLanguage(language);
      query = new Query(language, '(readonly_type (_) @operand) @operator\n(index_type_query (_) @operand) @operator');
      aliasQuery = new Query(language, '(type_alias_declaration value: (type/readonly_type (_) @operand) @operator)');
      tree = parser.parse(source)!;
      expect(tree.rootNode.hasError).toBe(false);
      expect(operandCaptures(query, tree)).toEqual(referenceOperands(source, dialect));
      expect(operandCaptures(aliasQuery, tree)).toEqual(referenceOperands(source, dialect, true));
      const offset = source.indexOf('|');
      for (const operator of ['&', '|']) {
        const next = source.slice(0, offset) + operator + source.slice(offset + 1);
        tree.edit(
          new Edit({
            startIndex: offset,
            oldEndIndex: offset + 1,
            newEndIndex: offset + 1,
            startPosition: position(source, offset),
            oldEndPosition: position(source, offset + 1),
            newEndPosition: position(next, offset + 1),
          })
        );
        const previous: Tree = tree;
        tree = parser.parse(next, previous)!;
        previous.delete();
        const fresh = parser.parse(next)!;
        try {
          expect(tree.rootNode.hasError).toBe(false);
          expect(snapshot(tree.rootNode)).toEqual(snapshot(fresh.rootNode));
          const expected = referenceOperands(next, dialect);
          expect(operandCaptures(query, tree)).toEqual(expected);
          expect(operandCaptures(query, fresh)).toEqual(expected);
          const aliases = referenceOperands(next, dialect, true);
          expect(operandCaptures(aliasQuery, tree)).toEqual(aliases);
          expect(operandCaptures(aliasQuery, fresh)).toEqual(aliases);
        } finally {
          fresh.delete();
        }
        source = next;
      }
    } finally {
      tree?.delete();
      query?.delete();
      aliasQuery?.delete();
      parser.delete();
    }
  });
}

function position(source: string, index: number): Point {
  const lines = source.slice(0, index).split('\n');
  return { row: lines.length - 1, column: lines.at(-1)!.length };
}

function referenceOperands(source: string, dialect: string, aliasesOnly = false): OperandCapture[] {
  const reference = ts.createSourceFile(
    `readonly.${dialect === 'tsx' ? 'tsx' : 'ts'}`,
    source,
    ts.ScriptTarget.Latest,
    true,
    dialect === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const expected: OperandCapture[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeOperatorNode(node) &&
      (node.operator === ts.SyntaxKind.ReadonlyKeyword || node.operator === ts.SyntaxKind.KeyOfKeyword) &&
      (!aliasesOnly || (node.operator === ts.SyntaxKind.ReadonlyKeyword && ts.isTypeAliasDeclaration(node.parent)))
    )
      expected.push([
        node.getStart(reference),
        node.type.getText(reference),
        node.type.getStart(reference),
        node.type.getEnd(),
      ]);
    ts.forEachChild(node, visit);
  };
  visit(reference);
  return expected.toSorted((a, b) => a[0] - b[0]);
}

function operandCaptures(query: Query, tree: Tree): OperandCapture[] {
  return query
    .matches(tree.rootNode)
    .map(({ captures }) => {
      const operator = captures.find(({ name }) => name === 'operator')!.node;
      const operand = captures.find(({ name }) => name === 'operand')!.node;
      return [operator.startIndex, operand.text, operand.startIndex, operand.endIndex] as const;
    })
    .toSorted((a, b) => a[0] - b[0]);
}

function snapshot(node: Node): unknown {
  return [
    node.type,
    node.isNamed,
    node.isMissing,
    node.startIndex,
    node.endIndex,
    node.startPosition,
    node.endPosition,
    node.children.map((_, i) => node.fieldNameForChild(i)),
    node.children.map(snapshot),
  ];
}
