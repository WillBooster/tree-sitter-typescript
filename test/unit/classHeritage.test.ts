import { Parser, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { expectNodeRanges } from '../helpers/nodeRanges.js';
import { loadCurrentWasmBuild } from './wasmBuild';

const ValidBases = [
  'Base',
  'Base<T>',
  'Base<-1>',
  'Base<-1n>',
  'factory<-1>()',
  'Base< <T>() => T>',
  'Base</* comment */ -1>',
  'Base<// comment\n-1n>',
  'Base!',
  'Base!<T>',
  'factory<T>()',
  'factory<<T>() => T>()',
  'factory<(value: T) => U>()',
  'factory<{ method<T>(value: T): U }>()',
  'Base<T extends U ? T : U>',
  'Base<`prefix${T}`>',
  'factory<T>?.()',
  'factory<T>`text`',
  'factory<T>().Base<U>',
  'factory<T>()[index]',
  'Base?.member',
  'Base?.[index]',
  'Base?.<T>()',
  'new Base',
  'new Base.member',
  'new Base[index]',
  'new Base`text`',
  'new Base<T>',
  'new Base<T>()',
  'new new Base<T>()',
  '(Base < 1)',
  '(Base + Other)',
  '(Base as Other)',
  '(Base satisfies Other)',
  '(value => value)',
  'function () {}',
  'async function () {}',
  'function* () {}',
  'class {}',
  '{ Base }',
  '[Base]',
  'import("module")',
];
const InvalidBases = [
  'Base < 1',
  'Base<function.Member>',
  'Base<import.Member>',
  'Base + Other',
  'Base + Other.member',
  'Base + factory<T>()',
  'Base || Other',
  'Base ? Other : Last',
  'Base = Other',
  '!Base',
  'Base++',
  'Base as Other',
  'Base satisfies Other',
  'value => value',
];
const BrokenHeader = 'class C extends Base<\n';
const RepairedHeader = 'class C extends Base<T> {}\n';
const Following = 'class Later {}\nexport function following() {}\nexport const sentinel = 2;';

await Parser.init();
for (const dialect of ['typescript', 'tsx'] as const) {
  test(`restricts ${dialect} superclass operands without losing valid reference chains`, async () => {
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser().setLanguage(language);
    try {
      const valid = [...ValidBases, ...(dialect === 'tsx' ? ['(<Component />)', 'factory(<Component />)'] : [])];
      for (const base of valid) {
        for (const gap of [' ', '\n', '/* comment */']) {
          const source = `class C extends ${base}${gap}{}\n${Following}`;
          const reference = ts.createSourceFile('source.' + (dialect === 'tsx' ? 'tsx' : 'ts'), source, 99, true);
          const expectedBase = (reference.statements[0] as ts.ClassDeclaration).heritageClauses![0]!.types[0]!;
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(false);
            expectNodeRanges(tree.rootNode, source);
            const clause = tree.rootNode.descendantsOfType('extends_clause')[0]!;
            const value = clause.childForFieldName('value')!;
            expect(value.text, source).toBe(expectedBase.expression.getText(reference));
            if (ts.isNewExpression(expectedBase.expression)) {
              expect(value.type, source).toBe('new_expression');
              expect(value.childForFieldName('constructor')?.text, source).toBe(
                expectedBase.expression.expression.getText(reference)
              );
            }
          } finally {
            tree.delete();
          }
        }
      }
      for (const base of InvalidBases) {
        const source = `class C extends ${base} {}\n${Following}`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(true);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });

  test(`keeps contextual superclass names scoped to their ${dialect} function`, async () => {
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const [source, valid] of [
        ['class C extends await {}', true],
        ['class C extends yield.member {}', true],
        ['function* outer() { class C extends yield {} }', false],
        ['function* outer() { class C extends yield() {} }', false],
        ['async function outer() { class C extends await {} }', false],
        ['function outer() { class C extends yield {} }', true],
        ['function outer() { class C extends await {} }', true],
        ['function* outer() { class C extends await {} }', true],
        ['async function outer() { class C extends yield {} }', true],
        ['async function* outer() { class C extends Base.yield {} }', true],
        ['async function* outer() { class C extends Base.await {} }', true],
        ['const object = { yield() {}, await: 1 }; class C extends object.yield {}', true],
      ] as const) {
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(!valid);
          expectNodeRanges(tree.rootNode, source);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });

  test(`preserves following ${dialect} declarations after an unfinished superclass`, async () => {
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const header of [BrokenHeader, RepairedHeader]) {
        const source = header + Following;
        const tree = parser.parse(source)!;
        try {
          checkFollowing(tree, source, header === BrokenHeader);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });
}

function checkFollowing(tree: Tree, source: string, hasError: boolean): void {
  expect(tree.rootNode.hasError, source).toBe(hasError);
  expectNodeRanges(tree.rootNode, source);
  expect(
    tree.rootNode.namedChildren
      .filter((node) => !node.hasError)
      .slice(-3)
      .map((node) => node.text),
    source
  ).toEqual(Following.split('\n'));
}
