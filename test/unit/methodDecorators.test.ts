import { Edit, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { compareEditedTree, position } from '../helpers/treeEdit.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

const Source = `class Example extends Base {
  @first @second('value') public override method<T>(@argument value: T): T { return value; }
  @observe static async fetch() {}
  @observe *iterate() { yield 1; }
  @observe get value() { return 1; }
  @observe set value(next: number) {}
  @observe ['computed']() {}
  plain() {}
  @field property = 1;
}
`;

for (const dialect of ['typescript', 'tsx']) {
  test(`attaches ${dialect} method decorators to their method through edits`, async () => {
    await Parser.init();
    const parser = new Parser();
    let tree: Tree | undefined;
    let query: Query | undefined;
    try {
      const language = await loadCurrentWasmBuild(dialect);
      parser.setLanguage(language);
      query = new Query(language, '(method_definition decorator: (decorator) @decorator) @method');
      for (const source of ['const value = { @observe method() {} };', 'const value = { @observe get value() {} };']) {
        const invalid = parser.parse(source)!;
        try {
          expect(invalid.rootNode.hasError).toBe(true);
        } finally {
          invalid.delete();
        }
      }
      let source = Source;
      tree = parser.parse(source)!;
      checkDecorators(tree, source, query);
      const start = source.indexOf('@first');
      let previousLength = '@first'.length;
      for (const replacement of ['@replacement() @additional', '', '@first']) {
        const next = source.slice(0, start) + replacement + source.slice(start + previousLength);
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex: start,
            oldEndIndex: start + previousLength,
            newEndIndex: start + replacement.length,
            startPosition: position(source, start),
            oldEndPosition: position(source, start + previousLength),
            newEndPosition: position(next, start + replacement.length),
          }),
          (incremental, fresh) => {
            checkDecorators(incremental, next, query!);
            checkDecorators(fresh, next, query!);
          }
        );
        previous.delete();
        source = next;
        previousLength = replacement.length;
      }
    } finally {
      tree?.delete();
      query?.delete();
      parser.delete();
    }
  });
}

function checkDecorators(tree: Tree, source: string, query: Query): void {
  expect(tree.rootNode.hasError).toBe(false);
  const reference = ts.createSourceFile('methods.ts', source, ts.ScriptTarget.Latest, true);
  const expected: unknown[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      for (const decorator of ts.getDecorators(node) ?? []) {
        expected.push([
          node.name.getText(reference),
          node.getStart(reference),
          decorator.getStart(reference),
          decorator.end,
        ]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(reference);
  expect(
    query.matches(tree.rootNode).map(({ captures }) => {
      const method = captures.find(({ name }) => name === 'method')!.node;
      const decorator = captures.find(({ name }) => name === 'decorator')!.node;
      expect(decorator.parent?.id).toBe(method.id);
      return [method.childForFieldName('name')!.text, method.startIndex, decorator.startIndex, decorator.endIndex];
    })
  ).toEqual(expected);
  const classBody = tree.rootNode.descendantsOfType('class_body')[0]!;
  expect(classBody.childrenForFieldName('decorator')).toEqual([]);
  expect(
    classBody
      .descendantsOfType('public_field_definition')[0]!
      .childrenForFieldName('decorator')
      .map((node) => node.text)
  ).toEqual(['@field']);
  expect(
    classBody
      .descendantsOfType('required_parameter')[0]!
      .childrenForFieldName('decorator')
      .map((node) => node.text)
  ).toEqual(['@argument']);
}
