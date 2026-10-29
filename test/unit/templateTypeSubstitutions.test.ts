import { Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
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
  test(`retains ${dialect} template type operands`, async () => {
    await Parser.init();
    const parser = new Parser();
    let query: Query | undefined;
    try {
      const language = await loadCurrentWasmBuild(dialect);
      parser.setLanguage(language);
      query = new Query(language, '(template_type (_) @operand)');
      for (const source of [Source, Source.replace('readonly ', '')]) {
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError).toBe(false);
          expect(operands(query, tree)).toEqual(referenceOperands(source, dialect));
        } finally {
          tree.delete();
        }
      }
    } finally {
      query?.delete();
      parser.delete();
    }
  });
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
