import { Parser, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { loadCurrentWasmBuild } from './wasmBuild.js';

const Prefix = `let value = 1;
const object = { value: 1 };
const array = [1];
function get() { return object; }
const result = `;
const Suffix = ';\nconst following = 1;';
const CommonExpressions = [
  'value++',
  'value--',
  '++value',
  '--value',
  'value!++',
  '(value as number)++',
  '(value satisfies number)--',
  'get().value++',
  'value\n++value',
];
const AssertionExpressions = [
  '<number>value++',
  '<number>value--',
  '<number>object.value--',
  '<number>array[0]++',
  '<number>get().value++',
  '<number>value!++',
  '<number><number>value++',
  '<number>++value',
  '<number>--value',
  '<number>(value++)',
  '(<number>value)++',
  '<number>value++ + 1',
  '<number>value /* inline */ ++',
  '<number>value\n++value',
  '<number>value/*\n*/--value',
];

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves compiler assertion and update operands in ${dialect}`, async () => {
    await Parser.init();
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    const expressions = dialect === 'typescript' ? [...AssertionExpressions, ...CommonExpressions] : CommonExpressions;
    try {
      for (const expression of expressions) {
        const source = Prefix + expression + Suffix;
        const tree = parser.parse(source)!;
        try {
          checkOperands(tree, source, dialect);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });
}

function checkOperands(tree: Tree, source: string, dialect: string): void {
  const fileName = dialect === 'tsx' ? 'fixture.tsx' : 'fixture.ts';
  expect(ts.transpileModule(source, { fileName, reportDiagnostics: true }).diagnostics ?? [], source).toEqual([]);
  const reference = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const assertions: unknown[] = [];
  const updates: unknown[] = [];
  const range = (node: ts.Node): unknown => [node.getStart(reference), node.end, node.getText(reference)];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAssertionExpression(node)) assertions.push([range(node), range(node.expression)]);
    if (
      ts.isPostfixUnaryExpression(node) ||
      (ts.isPrefixUnaryExpression(node) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken))
    )
      updates.push([range(node), range(node.operand), ts.tokenToString(node.operator)]);
    ts.forEachChild(node, visit);
  };
  visit(reference);
  expect(tree.rootNode.hasError, source).toBe(false);
  expect(
    tree.rootNode.descendantsOfType('type_assertion').map((node) => {
      const operand = node.lastNamedChild!;
      return [
        [node.startIndex, node.endIndex, node.text],
        [operand.startIndex, operand.endIndex, operand.text],
      ];
    }),
    source
  ).toEqual(assertions);
  expect(
    tree.rootNode.descendantsOfType('update_expression').map((node) => {
      const operand = node.childForFieldName('argument')!;
      return [
        [node.startIndex, node.endIndex, node.text],
        [operand.startIndex, operand.endIndex, operand.text],
        node.childForFieldName('operator')!.text,
      ];
    }),
    source
  ).toEqual(updates);
  expect(tree.rootNode.lastNamedChild!.text).toBe('const following = 1;');
}
