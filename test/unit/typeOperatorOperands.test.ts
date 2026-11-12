import { Parser, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { nonExtraNamedChildren } from '../helpers/nodeRoles.js';
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
  test(`retains ${dialect} type-operator operands across union and intersection operators`, async () => {
    await Parser.init();
    const parser = new Parser();
    try {
      const language = await loadCurrentWasmBuild(dialect);
      parser.setLanguage(language);
      for (const source of [Source, Source.replace('|', '&')]) {
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError).toBe(false);
          expect(operandCaptures(tree)).toEqual(referenceOperands(source, dialect));
          expect(operandCaptures(tree, true)).toEqual(referenceOperands(source, dialect, true));
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });
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

function operandCaptures(tree: Tree, aliasesOnly = false): OperandCapture[] {
  return tree.rootNode
    .descendantsOfType(aliasesOnly ? 'readonly_type' : ['readonly_type', 'index_type_query'])
    .filter((operator) => !aliasesOnly || operator.parent?.childForFieldName('value')?.id === operator.id)
    .flatMap((operator) =>
      nonExtraNamedChildren(operator).map(
        (operand) => [operator.startIndex, operand.text, operand.startIndex, operand.endIndex] as const
      )
    )
    .toSorted((a, b) => a[0] - b[0]);
}
