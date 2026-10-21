import { Edit, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { compareEditedTree, position } from '../helpers/treeEdit.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

const Prefix = `declare function f<T>(value?: unknown): T;
declare class Box<T> {}
declare const holder: { f: typeof f };
const call = f<<T>() => T>();
const instance = f<<T>() => T>;
const optional = f?.<<T>() => T>();
const constructed = new Box<<T>() => T>();
const bare = new Box<<T>() => T>;
const tagged = f<<T>() => T>\`text\`;
const member = holder.f<<T>() => T>();
const shifted = (1 << 2) >> 1;
let bits = 1;
bits <<= 2;
const compared = 1 < 2 && 3 > 2;
const editable = f<`;
const Suffix = `>();
const following = 1;
`;
const InitialArgument = '<T>() => T';

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves adjacent generic function arguments and shift operators through ${dialect} edits`, async () => {
    await Parser.init();
    const parser = new Parser();
    let query: Query | undefined;
    let tree: Tree | undefined;
    let source = Prefix + InitialArgument + Suffix;
    let argument = InitialArgument;
    try {
      const language = await loadCurrentWasmBuild(dialect);
      parser.setLanguage(language);
      query = new Query(language, '(type_arguments) @arguments (function_type) @function');
      tree = parser.parse(source)!;
      checkArguments(tree, source, dialect, query);
      for (const nextArgument of [
        ' <T>() => T',
        '/* gap */<T>() => T',
        '\n<T>() => T',
        '<T extends { nested: Box<string> }>(value: T) => T',
        '<T = string>(value?: T) => T',
        InitialArgument,
      ]) {
        const next = Prefix + nextArgument + Suffix;
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex: Prefix.length,
            oldEndIndex: Prefix.length + argument.length,
            newEndIndex: Prefix.length + nextArgument.length,
            startPosition: position(source, Prefix.length),
            oldEndPosition: position(source, Prefix.length + argument.length),
            newEndPosition: position(next, Prefix.length + nextArgument.length),
          }),
          (incremental, fresh) => {
            checkArguments(incremental, next, dialect, query!);
            checkArguments(fresh, next, dialect, query!);
          }
        );
        previous.delete();
        source = next;
        argument = nextArgument;
      }
    } finally {
      tree?.delete();
      query?.delete();
      parser.delete();
    }
  });
}

function checkArguments(tree: Tree, source: string, dialect: string, query: Query): void {
  expect(tree.rootNode.hasError, source).toBe(false);
  const reference = ts.createSourceFile(
    `arguments.${dialect === 'tsx' ? 'tsx' : 'ts'}`,
    source,
    ts.ScriptTarget.Latest,
    true,
    dialect === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const argumentsRanges: [string, number, number][] = [];
  const functionRanges: [string, number, number][] = [];
  const operators: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isCallExpression(node) ||
        ts.isNewExpression(node) ||
        ts.isTaggedTemplateExpression(node) ||
        ts.isExpressionWithTypeArguments(node) ||
        ts.isTypeReferenceNode(node)) &&
      node.typeArguments?.length
    ) {
      const start = node.typeArguments.pos - 1;
      const close = node.getChildren(reference).find((child) => child.kind === ts.SyntaxKind.GreaterThanToken)!;
      argumentsRanges.push([source.slice(start, close.end), start, close.end]);
    }
    if (ts.isFunctionTypeNode(node)) functionRanges.push([node.getText(reference), node.getStart(reference), node.end]);
    if (ts.isBinaryExpression(node)) operators.push(node.operatorToken.getText(reference));
    ts.forEachChild(node, visit);
  };
  visit(reference);
  const captures = query.captures(tree.rootNode);
  for (const [name, expected] of [
    ['arguments', argumentsRanges],
    ['function', functionRanges],
  ] as const) {
    expect(
      captures.filter((capture) => capture.name === name).map(({ node }) => [node.text, node.startIndex, node.endIndex])
    ).toEqual(expected);
  }
  expect(
    tree.rootNode
      .descendantsOfType(['binary_expression', 'augmented_assignment_expression'])
      .map((node) => node.childForFieldName('operator')!.text)
  ).toEqual(operators);
  for (const { node } of captures.filter((capture) => capture.name === 'arguments')) {
    expect(node.parent!.childForFieldName('type_arguments')?.id).toBe(node.id);
  }
  expect(tree.rootNode.lastNamedChild!.text).toBe('const following = 1;');
}
