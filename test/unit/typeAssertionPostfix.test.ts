import { Edit, Parser, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { configuredQueries } from '../helpers/configuredQueries.js';
import { compareEditedTree, position } from '../helpers/treeEdit.js';
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
  test(`preserves compiler assertion and update operands through ${dialect} edits`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser().setLanguage(language);
    const queries: ReturnType<typeof configuredQueries> = [];
    const expressions = dialect === 'typescript' ? [...AssertionExpressions, ...CommonExpressions] : CommonExpressions;
    const captures = (tree: Tree): unknown =>
      queries.map((query) =>
        query
          .captures(tree.rootNode)
          .map(({ name, node }) => [name, node.type, node.text, node.startIndex, node.endIndex])
      );
    let source = Prefix + expressions[0]! + Suffix;
    let tree: Tree | undefined;
    try {
      queries.push(...configuredQueries(language, dialect));
      tree = parser.parse(source)!;
      checkOperands(tree, source, dialect);
      for (const expression of [...expressions.slice(1), expressions[0]!]) {
        const next = Prefix + expression + Suffix;
        let startIndex = 0;
        let oldEndIndex = source.length;
        let newEndIndex = next.length;
        while (startIndex < oldEndIndex && startIndex < newEndIndex && source[startIndex] === next[startIndex])
          startIndex++;
        while (
          oldEndIndex > startIndex &&
          newEndIndex > startIndex &&
          source[oldEndIndex - 1] === next[newEndIndex - 1]
        ) {
          oldEndIndex--;
          newEndIndex--;
        }
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex,
            oldEndIndex,
            newEndIndex,
            startPosition: position(source, startIndex),
            oldEndPosition: position(source, oldEndIndex),
            newEndPosition: position(next, newEndIndex),
          }),
          (incremental, fresh) => {
            checkOperands(incremental, next, dialect);
            checkOperands(fresh, next, dialect);
            expect(captures(incremental)).toEqual(captures(fresh));
          }
        );
        previous.delete();
        source = next;
      }
    } finally {
      tree?.delete();
      for (const query of queries) query.delete();
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
