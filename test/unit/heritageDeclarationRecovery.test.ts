import { Edit, Parser, type Tree } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

import { compareEditedTree, expectNodeRanges, position } from '../helpers/treeEdit';
import { loadCurrentWasmBuild } from './wasmBuild';

const Declarations = [
  ['interface I {}', 'interface_declaration'],
  ['enum E { A }', 'enum_declaration'],
  ['let value = 1;', 'lexical_declaration'],
  ['function following() {}', 'function_declaration'],
  ['function* following() {}', 'generator_function_declaration'],
  ['interface LongIdentifierBeyondSixteen {}', 'interface_declaration'],
  ['interface 日本 {}', 'interface_declaration'],
  [String.raw`interface \u0049 {}`, 'interface_declaration'],
] as const;
const BrokenHeader = 'class C extends Base<\n';
const RepairedHeader = 'class C extends Base<T> {}\n';
const Sentinel = 'export const sentinel = 2;';
const ValidTypes = [
  'interface',
  'function',
  'let',
  'interface extends T ? U : V',
  'function extends T ? U : V',
  'let extends T ? U : V',
  'interface<T>',
  'let<T>',
  'interface/* gap */extends T ? U : V',
  'let/* gap */extends T ? U : V',
  'function/* gap */extends T ? U : V',
  'interface.Member<T>',
  'let.Member<T>',
  'interface[T]',
  'let[T]',
  'function[]',
  'keyof T',
  'typeof value',
  'readonly T[]',
  'unique symbol',
  'T extends infer U ? U : never',
  'import("module").T',
  '-1',
  '-1n',
  '<T>() => T',
];
const Trivia = [' ', '\n', '/* comment */', '// comment\n', '/* line\nbreak */'];

await Parser.init();
for (const dialect of ['typescript', 'tsx'] as const) {
  test(`preserves ${dialect} declarations after an unfinished superclass type list`, async () => {
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const [declaration, kind] of Declarations) {
        for (const gap of Trivia) {
          const withTrivia = declaration.replace(/^(interface|enum|let|function) /, `$1${gap}`);
          const following = withTrivia + '\n' + Sentinel;
          let header = BrokenHeader;
          let tree = parser.parse(header + following)!;
          try {
            checkFollowing(tree, header + following, withTrivia, kind, true);
            for (const replacement of [RepairedHeader, BrokenHeader]) {
              const source = replacement + following;
              const next = compareEditedTree(
                parser,
                tree,
                source,
                new Edit({
                  startIndex: 0,
                  oldEndIndex: header.length,
                  newEndIndex: replacement.length,
                  startPosition: { row: 0, column: 0 },
                  oldEndPosition: position(header, header.length),
                  newEndPosition: position(replacement, replacement.length),
                }),
                (incremental, fresh) => {
                  checkFollowing(incremental, source, withTrivia, kind, replacement === BrokenHeader);
                  checkFollowing(fresh, source, withTrivia, kind, replacement === BrokenHeader);
                },
                true
              );
              tree.delete();
              tree = next;
              header = replacement;
            }
          } finally {
            tree.delete();
          }
        }
      }
    } finally {
      parser.delete();
    }
  });

  test(`retains valid ${dialect} types that resemble declaration starts`, async () => {
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const type of ValidTypes) {
        for (const gap of Trivia) {
          const source = `class C extends Base<${gap}${type}> {}\n${Sentinel}`;
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(false);
            expectNodeRanges(tree.rootNode, source);
            expect(tree.rootNode.descendantsOfType('type_arguments')[0]?.text, source).toBe(`<${gap}${type}>`);
            expect(tree.rootNode.lastNamedChild?.text, source).toBe(Sentinel);
          } finally {
            tree.delete();
          }
        }
      }
    } finally {
      parser.delete();
    }
  });
}

function checkFollowing(tree: Tree, source: string, declaration: string, kind: string, hasError: boolean): void {
  expect(tree.rootNode.hasError, source).toBe(hasError);
  expectNodeRanges(tree.rootNode, source);
  expect(
    tree.rootNode.namedChildren
      .filter((node) => !node.hasError && node.type !== 'comment')
      .slice(-2)
      .map((node) => [node.type, node.text]),
    source
  ).toEqual([
    [kind, declaration],
    ['export_statement', Sentinel],
  ]);
}
