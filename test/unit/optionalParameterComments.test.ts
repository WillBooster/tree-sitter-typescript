import { Parser, type Tree } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

import { loadCurrentWasmBuild } from './wasmBuild';

const Names = ['value', 'unknown', 'never', 'unique', 'keyof'];
const Comments = [
  ['/* c */', ['/* c */']],
  ['/* c */ /* d */', ['/* c */', '/* d */']],
  ['// c\n', ['// c']],
  ['/*\n c\n*/', ['/*\n c\n*/']],
  ['/* c */\n// d\n', ['/* c */', '// d']],
] as const;
const Signatures = [
  (parameter: string) => `type F = (${parameter}) => void;`,
  (parameter: string) => `declare function f(${parameter}): void;`,
  (parameter: string) => `const g = (${parameter}) => 1;`,
  (parameter: string) => `function f(${parameter}): void {}`,
  (parameter: string) => `interface I { m(${parameter}): void; }`,
  (parameter: string) => `class C { m(${parameter}): void {} }`,
  (parameter: string) => `const o = { m(${parameter}): void {} };`,
  (parameter: string) => `class C { constructor(${parameter}) {} }`,
  (parameter: string) => `type F = new (${parameter}) => C;`,
  (parameter: string) => `interface I { (${parameter}): void; }`,
  (parameter: string) => `type F = <T>(${parameter}) => T;`,
];
const Following = 'export function after() { return 1; }';

for (const dialect of ['typescript', 'tsx']) {
  for (const signature of Signatures) {
    test(`preserves ${dialect} optional-parameter fields and comments in ${signature('value? : string')}`, async () => {
      await Parser.init();
      const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
      try {
        for (const name of Names) {
          for (const [comment, expectedComments] of Comments) {
            const original = `${signature(`${name}? ${comment} : string`)}\n${Following}`;
            for (const [source, expected] of [
              [original, expectedComments],
              [original.replace(comment, ''), []],
              [original.replace(': string', ': '), undefined],
            ] as const) {
              const tree = parser.parse(source)!;
              try {
                expect(tree.rootNode.hasError, source).toBe(expected === undefined);
                const following = tree.rootNode.lastNamedChild!;
                expect([following.type, following.text, following.hasError], source).toEqual([
                  'export_statement',
                  Following,
                  false,
                ]);
                if (expected) check(tree, source, name, expected);
              } finally {
                tree.delete();
              }
            }
          }
        }
      } finally {
        parser.delete();
      }
    });
  }
  test(`retains ${dialect} ternary operands with and without a consequence`, async () => {
    await Parser.init();
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const [comment] of Comments) {
        for (const consequence of ['consequence', '']) {
          const source = `const result = condition? ${comment} ${consequence} : alternative;\n${Following}`;
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(consequence === '');
            const ternaries = tree.rootNode.descendantsOfType('ternary_expression');
            expect(ternaries, source).toHaveLength(1);
            const ternary = ternaries[0]!;
            expect(ternary.childForFieldName('condition')!.text, source).toBe('condition');
            expect(ternary.childForFieldName('alternative')!.text, source).toBe('alternative');
            const node = ternary.childForFieldName('consequence')!;
            expect([node.text, node.isMissing], source).toEqual([consequence, consequence === '']);
            expect(tree.rootNode.lastNamedChild!.text, source).toBe(Following);
            expect(tree.rootNode.lastNamedChild!.hasError, source).toBe(false);
          } finally {
            tree.delete();
          }
        }
      }
    } finally {
      parser.delete();
    }
  });
  test(`accepts ${dialect} commented optional parameters without annotations`, async () => {
    await Parser.init();
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const [comment, expectedComments] of Comments) {
        for (const signature of [
          `declare function f(value?${comment}): void;`,
          `declare function f(value?${comment}, other?: number): void;`,
          `const f = (value?${comment}) => 1;`,
          `type F = (value?${comment}) => void;`,
        ]) {
          const source = `${signature}\n${Following}`;
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(false);
            const parameter = tree.rootNode
              .descendantsOfType('optional_parameter')
              .find((node) => node.childForFieldName('pattern')?.text === 'value')!;
            expect(parameter, source).toBeDefined();
            expect(parameter.childForFieldName('type'), source).toBeNull();
            expect(parameter.children.find((node) => node.type === '?')!.text, source).toBe('?');
            expect(
              tree.rootNode.descendantsOfType('comment').map((node) => [node.text, node.isExtra]),
              source
            ).toEqual(expectedComments.map((text) => [text, true]));
            expect(tree.rootNode.lastNamedChild!.text, source).toBe(Following);
          } finally {
            tree.delete();
          }
        }
      }
    } finally {
      parser.delete();
    }
  });
  test(`retains ${dialect} regex consequences after probing optional comments`, async () => {
    await Parser.init();
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const comment of ['', '/* c */', '// c\n']) {
        for (const regex of ['/./', '/:/', '/[)]/']) {
          for (const expression of [
            `const result = (condition? ${comment} ${regex} : alternative);`,
            `call(condition? ${comment} ${regex} : alternative);`,
          ]) {
            const source = `${expression}\n${Following}`;
            const tree = parser.parse(source)!;
            try {
              expect(tree.rootNode.hasError, source).toBe(false);
              const ternary = tree.rootNode.descendantsOfType('ternary_expression')[0]!;
              expect(ternary, source).toBeDefined();
              expect(ternary.childForFieldName('condition')!.text, source).toBe('condition');
              expect(ternary.childForFieldName('consequence')!.type, source).toBe('regex');
              expect(ternary.childForFieldName('consequence')!.text, source).toBe(regex);
              expect(ternary.childForFieldName('alternative')!.text, source).toBe('alternative');
              expect(tree.rootNode.lastNamedChild!.text, source).toBe(Following);
            } finally {
              tree.delete();
            }
          }
        }
      }
    } finally {
      parser.delete();
    }
  });
}

function check(tree: Tree, source: string, name: string, comments: readonly string[]): void {
  expect(tree.rootNode.hasError, source).toBe(false);
  const parameters = tree.rootNode.descendantsOfType('optional_parameter');
  expect(parameters, source).toHaveLength(1);
  const parameter = parameters[0]!;
  const pattern = parameter.childForFieldName('pattern')!;
  expect([pattern.type, pattern.text, pattern.startIndex, pattern.endIndex], source).toEqual([
    'identifier',
    name,
    source.indexOf(`${name}?`),
    source.indexOf(`${name}?`) + name.length,
  ]);
  const annotation = parameter.childForFieldName('type')!;
  const annotationStart = source.indexOf(': string');
  expect([annotation.type, annotation.text, annotation.startIndex, annotation.endIndex], source).toEqual([
    'type_annotation',
    ': string',
    annotationStart,
    annotationStart + ': string'.length,
  ]);
  expect([parameter.startIndex, parameter.endIndex], source).toEqual([pattern.startIndex, annotation.endIndex]);
  const question = parameter.children.find((node) => node.type === '?')!;
  expect([question.isNamed, question.startIndex, question.endIndex], source).toEqual([
    false,
    source.indexOf('?'),
    source.indexOf('?') + 1,
  ]);
  expect(
    tree.rootNode.descendantsOfType('comment').map((node) => [node.text, node.isExtra, node.startIndex, node.endIndex]),
    source
  ).toEqual(
    comments.map((comment) => [comment, true, source.indexOf(comment), source.indexOf(comment) + comment.length])
  );
}
