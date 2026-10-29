import { Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { loadCurrentWasmBuild } from './wasmBuild.js';

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves ${dialect} exported class decorator ownership and declaration queries`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser().setLanguage(language);
    const query = new Query(
      language,
      `
      (export_statement declaration: (declaration) @declaration)
      (declaration/class_declaration decorator: (decorator) @decorator)
      (declaration/abstract_class_declaration decorator: (decorator) @decorator)
    `
    );
    try {
      for (const kind of ['class', 'abstract class']) {
        for (const head of [
          `@one() @two.member export ${kind} Named<T> extends Base<T> implements Shape<T>`,
          `@one() /* before export */ export default ${kind} Named<T>`,
          `@one() export default ${kind}`,
          `export @one() ${kind} Named`,
          `export default @one() ${kind}`,
          `@one() export declare ${kind} Named<T extends Box<Box<string>>> extends Base<T> implements Shape<T>`,
          `@one() /* comment */ export declare ${kind} Named`,
        ]) {
          const source = `${head} { value: number; }\n(next);`;
          const tree = parser.parse(source)!;
          try {
            check(tree, source, query);
            expect(tree.rootNode.lastNamedChild?.text).toBe('(next);');
          } finally {
            tree.delete();
          }
        }
        for (const modifiers of ['export ', 'export declare ', 'export default ', '']) {
          const source = `@one() ${modifiers}${kind} Named<T> { value: T; }`;
          const tree = parser.parse(source)!;
          try {
            check(tree, source, query);
          } finally {
            tree.delete();
          }
        }
      }
      for (const source of [
        '@before export @after class Named {}',
        '@before export default @after abstract class {}',
        '@dec export function named() {}',
        '@dec export const value = 1;',
        '@dec export default value;',
        '@dec export class {}',
        '@dec export abstract class {}',
        '@dec export declare class {}',
        '@dec export default declare class Named {}',
      ]) {
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(true);
        } finally {
          tree.delete();
        }
      }
    } finally {
      query.delete();
      parser.delete();
    }
  });
}

function check(tree: Tree, source: string, query: Query): void {
  expect(tree.rootNode.hasError, source).toBe(false);
  const reference = ts.createSourceFile('classes.ts', source, ts.ScriptTarget.Latest, true);
  expect(
    ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { experimentalDecorators: true } })
      .diagnostics
  ).toEqual([]);
  const expected: unknown[] = [];
  const ambient: string[] = [];
  const members: string[][] = [];
  for (const statement of reference.statements) {
    if (!ts.isClassDeclaration(statement)) continue;
    members.push(statement.members.filter(ts.isPropertyDeclaration).map((member) => member.name.getText(reference)));
    if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) {
      ambient.push(statement.name!.text);
    }
    for (const decorator of ts.getDecorators(statement) ?? []) {
      expected.push([statement.name?.text, decorator.getStart(reference), decorator.end]);
    }
  }
  expect(
    tree.rootNode.descendantsOfType(['class_declaration', 'abstract_class_declaration']).map((node) =>
      node
        .childForFieldName('body')!
        .namedChildren.filter((member) => member.type === 'public_field_definition')
        .map((member) => member.childForFieldName('name')!.text)
    )
  ).toEqual(members);
  expect(
    tree.rootNode
      .descendantsOfType('ambient_declaration')
      .map(
        (node) =>
          node.namedChildren.find((child) => child.type.endsWith('class_declaration'))!.childForFieldName('name')!.text
      )
  ).toEqual(ambient);
  const captures = query.captures(tree.rootNode);
  expect(
    captures
      .filter(({ name }) => name === 'decorator')
      .map(({ node }) => {
        const owner = node.parent!;
        expect(['class_declaration', 'abstract_class_declaration']).toContain(owner.type);
        expect(owner.childrenForFieldName('decorator').some((decorator) => decorator.id === node.id)).toBe(true);
        return [owner.childForFieldName('name')?.text, node.startIndex, node.endIndex];
      })
  ).toEqual(expected);
  const exported = tree.rootNode.namedChildren.filter((node) => node.type === 'export_statement');
  expect(captures.filter(({ name }) => name === 'declaration').map(({ node }) => node.id)).toEqual(
    exported.map((node) => node.childForFieldName('declaration')!.id)
  );
  for (const node of exported) {
    expect(node.childrenForFieldName('decorator')).toEqual([]);
    const exportedDeclaration = node.childForFieldName('declaration')!;
    const declaration =
      exportedDeclaration.type === 'ambient_declaration'
        ? exportedDeclaration.namedChildren.find((child) => child.type.endsWith('class_declaration'))!
        : exportedDeclaration;
    expect(declaration.startIndex).toBe(declaration.childrenForFieldName('decorator')[0]!.startIndex);
  }
}
