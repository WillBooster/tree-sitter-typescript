import { Edit, Parser, Query, type Node, type Point, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { loadCurrentWasmBuild } from './wasmBuild.js';

type Operand = readonly [string, number, number];

const Source = `type B = number;
type ReadonlyOperand = \`a\${readonly B[]}b\`;
type FunctionOperand = \`a\${() => B}b\`;
type ConstructorOperand = \`a\${new () => B}b\`;
type UnionOperand = \`a\${B | string}b\`;
type IntersectionOperand = \`a\${B & string}b\`;
type InferOperand<T> = T extends \`a\${infer U extends string}b\` ? U : never;
const value = \`a\${1 + 2}b\`;
`;

for (const dialect of ['typescript', 'tsx']) {
  test(`retains ${dialect} template type operands through edits`, async () => {
    await Parser.init();
    const parser = new Parser();
    let query: Query | undefined;
    let tree: Tree | undefined;
    let source = Source;
    try {
      const language = await loadCurrentWasmBuild(dialect);
      parser.setLanguage(language);
      query = new Query(language, '(template_type (_) @operand)');
      tree = parser.parse(source)!;
      expect(tree.rootNode.hasError).toBe(false);
      expect(operands(query, tree)).toEqual(referenceOperands(source, dialect));
      const offset = source.indexOf('readonly ');
      for (const replacement of ['', 'readonly ']) {
        const length = source.startsWith('readonly ', offset) ? 'readonly '.length : 0;
        const next = source.slice(0, offset) + replacement + source.slice(offset + length);
        tree.edit(
          new Edit({
            startIndex: offset,
            oldEndIndex: offset + length,
            newEndIndex: offset + replacement.length,
            startPosition: position(source, offset),
            oldEndPosition: position(source, offset + length),
            newEndPosition: position(next, offset + replacement.length),
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
          expect(operands(query, tree)).toEqual(expected);
          expect(operands(query, fresh)).toEqual(expected);
        } finally {
          fresh.delete();
        }
        source = next;
      }
    } finally {
      tree?.delete();
      query?.delete();
      parser.delete();
    }
  });
}

function position(source: string, index: number): Point {
  const lines = source.slice(0, index).split('\n');
  return { row: lines.length - 1, column: lines.at(-1)!.length };
}

function referenceOperands(source: string, dialect: string): Operand[] {
  const reference = ts.createSourceFile(
    `templates.${dialect === 'tsx' ? 'tsx' : 'ts'}`,
    source,
    ts.ScriptTarget.Latest,
    true,
    dialect === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const expected: Operand[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTemplateLiteralTypeNode(node))
      for (const { type } of node.templateSpans)
        expected.push([type.getText(reference), type.getStart(reference), type.getEnd()]);
    ts.forEachChild(node, visit);
  };
  visit(reference);
  return expected.toSorted((a, b) => a[1] - b[1]);
}

function operands(query: Query, tree: Tree): Operand[] {
  return query
    .captures(tree.rootNode)
    .map(({ node }) => [node.text, node.startIndex, node.endIndex] as const)
    .toSorted((a, b) => a[1] - b[1]);
}

function snapshot(node: Node): unknown {
  return [
    node.type,
    node.isNamed,
    node.isMissing,
    node.isExtra,
    node.hasError,
    node.startIndex,
    node.endIndex,
    node.startPosition,
    node.endPosition,
    node.children.map((_, i) => node.fieldNameForChild(i)),
    node.children.map(snapshot),
  ];
}
