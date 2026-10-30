import { type Node, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { loadCurrentWasmBuild } from './wasmBuild.js';

type CaptureRange = [string, number, number];

const Words = ['keyof', 'readonly', 'unique', 'infer', 'get', 'set', 'accessor', 'type', 'namespace', 'module'];
const Gaps = [' ', '\n', '\r\n', '\u2028', '\u2029', '/* comment */', '// comment\n'];
const Header =
  'export {};\n' +
  Words.map(
    (word) => `namespace ${word} {
      export interface Foo<T = unknown> {}
      export namespace Inner {
        export interface Deep<T = unknown> {}
        export namespace Deeper { export interface Leaf<T = unknown> {} }
      }
    }`
  ).join('\n') +
  '\nnamespace Outer {\n' +
  Words.map((word) => `export namespace ${word} { export interface Foo<T = unknown> {} }`).join('\n') +
  '\n}\n' +
  '\n';
const Suffix = ' { field = 1; method() { return this.field; } }\nconst following = 1;';
const RoleQuery = `
  (implements_clause (nested_type_identifier) @name)
  (implements_clause (generic_type name: (nested_type_identifier) @name))
`;

for (const dialect of ['typescript', 'tsx']) {
  test(`parses qualified contextual ${dialect} implements names with compiler fields`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser().setLanguage(language);
    const roles = new Query(language, RoleQuery);
    try {
      for (const word of Words) {
        for (const gap of Gaps) {
          const source =
            Header +
            `class C implements ${word}${gap}.${gap}Foo${gap}{ field = 1; }\n` +
            `class Generic implements ${word}${gap}.${gap}Foo${gap}<number> {}\n` +
            `class Deep implements ${word}.Inner${gap}.${gap}Deep<string> {}\n` +
            `class Nested implements ${word}.Inner.Deeper.Leaf<number> {}\n` +
            `class Middle implements Outer.${word}.Foo<number> {}\n` +
            `class Multiple implements ${word}.Foo, readonly.Inner.Deep<string> {}\n` +
            `interface Extended extends ${word}.Inner.Deep<number> {}\nconst following = 1;`;
          const tree = parser.parse(source)!;
          try {
            checkHeritage(tree, source, dialect, roles);
          } finally {
            tree.delete();
          }
        }
      }
    } finally {
      roles.delete();
      parser.delete();
    }
  });

  test(`parses qualified ${dialect} implements names before class bodies`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser().setLanguage(language);
    const roles = new Query(language, RoleQuery);
    try {
      for (const name of [
        'readonly.Foo',
        'readonly.Foo<number>',
        'keyof.Inner.Deep<number>',
        'unique.Inner.Deeper.Leaf<string>',
        'infer.Foo',
        'get.Foo',
        'type.Inner.Deep<number>',
        'namespace.Inner.Deeper.Leaf<string>',
        'Outer.get.Foo<number>',
      ]) {
        const source = Header + 'class C implements ' + name + Suffix;
        const tree = parser.parse(source)!;
        try {
          checkHeritage(tree, source, dialect, roles);
        } finally {
          tree.delete();
        }
      }
    } finally {
      roles.delete();
      parser.delete();
    }
  });
}

function checkHeritage(tree: Tree, source: string, dialect: string, roles: Query): void {
  const fileName = dialect === 'tsx' ? 'fixture.tsx' : 'fixture.ts';
  const reference = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  expect(
    ts.transpileModule(source, { fileName, reportDiagnostics: true }).diagnostics?.map((d) => d.code) ?? [],
    source
  ).toEqual([]);
  expect(tree.rootNode.hasError, source).toBe(false);
  const expected: CaptureRange[] = [];
  for (const statement of reference.statements) {
    if (!ts.isClassDeclaration(statement)) continue;
    const parsed = tree.rootNode
      .descendantsOfType('class_declaration')
      .find((node) => node.childForFieldName('name')?.text === statement.name?.text);
    expect(parsed, source).toBeDefined();
    const body = parsed!.childForFieldName('body')!;
    expect([body.type, body.startIndex, body.endIndex], source).toEqual([
      'class_body',
      statement
        .getChildren(reference)
        .find((child) => child.kind === ts.SyntaxKind.OpenBraceToken)!
        .getStart(reference),
      statement.end,
    ]);
    const names = parsed!
      .descendantsOfType('implements_clause')[0]!
      .namedChildren.map((node) => (node.type === 'generic_type' ? node.childForFieldName('name')! : node));
    const heritage = statement.heritageClauses!.flatMap((clause) => [...clause.types]);
    expect(names).toHaveLength(heritage.length);
    for (const [index, type] of heritage.entries()) {
      expected.push(['name', type.expression.getStart(reference), type.expression.end]);
      checkQualifiedName(names[index]!, type.expression, reference);
    }
  }
  const actual = roles
    .captures(tree.rootNode)
    .map(({ name, node }): CaptureRange => [name, node.startIndex, node.endIndex]);
  expect(actual.toSorted(compareCaptureRange), source).toEqual(expected.toSorted(compareCaptureRange));
  expect(tree.rootNode.lastNamedChild?.text, source).toBe('const following = 1;');
}

function checkQualifiedName(node: Node, expression: ts.Expression, reference: ts.SourceFile): void {
  if (!ts.isPropertyAccessExpression(expression)) throw new Error('Expected a qualified heritage expression');
  expect([node.type, node.startIndex, node.endIndex]).toEqual([
    'nested_type_identifier',
    expression.getStart(reference),
    expression.end,
  ]);
  checkLeaf(node.childForFieldName('name')!, expression.name, reference, 'type_identifier');
  checkModule(node.childForFieldName('module')!, expression.expression, reference, 'nested_identifier');
}

function checkModule(node: Node, expression: ts.Expression, reference: ts.SourceFile, kind: string): void {
  if (ts.isIdentifier(expression)) {
    checkLeaf(node, expression, reference, 'identifier');
    return;
  }
  if (!ts.isPropertyAccessExpression(expression)) throw new Error('Expected a qualified module expression');
  expect([node.type, node.startIndex, node.endIndex]).toEqual([kind, expression.getStart(reference), expression.end]);
  checkLeaf(node.childForFieldName('property')!, expression.name, reference, 'property_identifier');
  checkModule(node.childForFieldName('object')!, expression.expression, reference, 'member_expression');
}

function checkLeaf(node: Node, expression: ts.Node, reference: ts.SourceFile, kind: string): void {
  expect([node.type, node.childCount, node.startIndex, node.endIndex]).toEqual([
    kind,
    0,
    expression.getStart(reference),
    expression.end,
  ]);
}

function compareCaptureRange(left: CaptureRange, right: CaptureRange): number {
  return left[0].localeCompare(right[0]) || left[1] - right[1] || left[2] - right[2];
}
