import { Edit, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { compareEditedTree, position } from '../helpers/treeEdit.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves ${dialect} exported class decorator ownership and declaration queries through edits`, async () => {
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
          const source = `${head} {}\n(next);`;
          const tree = parser.parse(source)!;
          try {
            check(tree, source, query);
            expect(tree.rootNode.lastNamedChild?.text).toBe('(next);');
          } finally {
            tree.delete();
          }
        }
        let source = `@one() ${kind} Named<T> {}`;
        let tree = parser.parse(source)!;
        const start = source.indexOf(kind);
        let previous = '';
        try {
          for (const replacement of ['export ', 'export declare ', 'export default ', '']) {
            const next = source.slice(0, start) + replacement + source.slice(start + previous.length);
            const oldTree = tree;
            tree = compareEditedTree(
              parser,
              oldTree,
              next,
              new Edit({
                startIndex: start,
                oldEndIndex: start + previous.length,
                newEndIndex: start + replacement.length,
                startPosition: position(source, start),
                oldEndPosition: position(source, start + previous.length),
                newEndPosition: position(next, start + replacement.length),
              }),
              (incremental, fresh) => {
                check(incremental, next, query);
                check(fresh, next, query);
              }
            );
            oldTree.delete();
            source = next;
            previous = replacement;
          }
        } finally {
          tree.delete();
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
  for (const statement of reference.statements) {
    if (!ts.isClassDeclaration(statement)) continue;
    if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) {
      ambient.push(statement.name!.text);
    }
    for (const decorator of ts.getDecorators(statement) ?? []) {
      expected.push([statement.name?.text, decorator.getStart(reference), decorator.end]);
    }
  }
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
