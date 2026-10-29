import { Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { loadCurrentWasmBuild } from './wasmBuild.js';

const Prefix = `declare module "m" { export interface Foo<T = unknown> { member: T } }
type Plain = (import("m").Foo);
type Nested = ((import("m").Foo<number>));
type ArrayType = (import("m").Foo | string)[];
type Indexed = (import("m").Foo<number>)["member"];
type Keys = keyof (import("m").Foo);
type Factory = () => (import("m").Foo);
type Module = (typeof import("m"));
type Editable = (`;
const Suffix = `);
declare function factory(name: string): { Foo: unknown };
const ordinary = (factory("m").Foo);
const dynamic = (import("m").then);
const arrow = (value = import("m").then) => value;
const following = 1;
`;

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves parenthesized import types and expression boundaries in ${dialect}`, async () => {
    await Parser.init();
    const parser = new Parser();
    let query: Query | undefined;
    let tree: Tree | undefined;
    try {
      const language = await loadCurrentWasmBuild(dialect);
      parser.setLanguage(language);
      query = new Query(
        language,
        '(parenthesized_type) @type\n(parenthesized_type (primary_type) @operand)\n(lexical_declaration (variable_declarator name: (identifier) @binding))'
      );
      for (const operand of [
        'import("m").Foo',
        'import("m").Foo<number>',
        'keyof import("m").Foo<number>',
        'import("m").Foo<number> | string',
        '(import("m").Foo<number>)[]',
      ]) {
        const source = Prefix + operand + Suffix;
        tree = parser.parse(source)!;
        checkTypes(tree, source, dialect, query);
        tree.delete();
        tree = undefined;
      }
    } finally {
      tree?.delete();
      query?.delete();
      parser.delete();
    }
  });
}

function checkTypes(tree: Tree, source: string, dialect: string, query: Query): void {
  expect(tree.rootNode.hasError, source).toBe(false);
  const reference = ts.createSourceFile(
    `imports.${dialect === 'tsx' ? 'tsx' : 'ts'}`,
    source,
    ts.ScriptTarget.Latest,
    true,
    dialect === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const expected: [string, number, number][] = [];
  const operands: [string, number, number][] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isParenthesizedTypeNode(node)) {
      expected.push([node.getText(reference), node.getStart(reference), node.getEnd()]);
      operands.push([node.type.getText(reference), node.type.getStart(reference), node.type.getEnd()]);
    }
    ts.forEachChild(node, visit);
  };
  visit(reference);
  const captures = query.captures(tree.rootNode);
  expect(
    captures.filter(({ name }) => name === 'type').map(({ node }) => [node.text, node.startIndex, node.endIndex])
  ).toEqual(expected);
  expect(
    captures.filter(({ name }) => name === 'operand').map(({ node }) => [node.text, node.startIndex, node.endIndex])
  ).toEqual(operands);
  expect(captures.filter(({ name }) => name === 'binding').map(({ node }) => node.text)).toEqual([
    'ordinary',
    'dynamic',
    'arrow',
    'following',
  ]);
  expect(tree.rootNode.descendantsOfType('parenthesized_expression').map((node) => node.text)).toEqual([
    '(factory("m").Foo)',
    '(import("m").then)',
  ]);
}
