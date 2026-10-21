import { Edit, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

import { configuredQueries } from '../helpers/configuredQueries';
import { compareEditedTree, position } from '../helpers/treeEdit';
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
    test(`preserves ${dialect} optional-parameter fields and comments through edits in ${signature('value? : string')}`, async () => {
      await Parser.init();
      const language = await loadCurrentWasmBuild(dialect);
      const parser = new Parser().setLanguage(language);
      const queries: Query[] = [];
      const captures = (current: Tree): unknown[] =>
        queries.map((query) =>
          query
            .captures(current.rootNode)
            .map(({ name: capture, node }) => [capture, node.type, node.text, node.startIndex, node.endIndex])
        );
      try {
        queries.push(...configuredQueries(language, dialect));
        queries.push(
          new Query(
            language,
            '(optional_parameter pattern: (identifier) @binding type: (type_annotation) @type) @parameter'
          )
        );
        for (const name of Names) {
          for (const [comment, expectedComments] of Comments) {
            let source = `${signature(`${name}? ${comment} : string`)}\n${Following}`;
            let tree = parser.parse(source)!;
            try {
              check(tree, source, name, expectedComments);
              const commentStart = source.indexOf(comment);
              for (const [start, before, after, expected] of [
                [commentStart, comment, '', []],
                [commentStart, '', comment, expectedComments],
                [source.indexOf(': string'), ': string', ': ', undefined],
                [source.indexOf(': string'), ': ', ': string', expectedComments],
              ] as const) {
                const next = source.slice(0, start) + after + source.slice(start + before.length);
                const previous = tree;
                tree = compareEditedTree(
                  parser,
                  previous,
                  next,
                  new Edit({
                    startIndex: start,
                    oldEndIndex: start + before.length,
                    newEndIndex: start + after.length,
                    startPosition: position(source, start),
                    oldEndPosition: position(source, start + before.length),
                    newEndPosition: position(next, start + after.length),
                  }),
                  (incremental, fresh) => {
                    expect(captures(incremental), next).toEqual(captures(fresh));
                    for (const current of [incremental, fresh]) {
                      expect(current.rootNode.hasError, next).toBe(expected === undefined);
                      const following = current.rootNode.lastNamedChild!;
                      expect([following.type, following.text, following.hasError], next).toEqual([
                        'export_statement',
                        Following,
                        false,
                      ]);
                      if (expected) check(current, next, name, expected);
                    }
                  },
                  true
                );
                previous.delete();
                source = next;
              }
            } finally {
              tree.delete();
            }
          }
        }
      } finally {
        for (const query of queries) query.delete();
        parser.delete();
      }
    });
  }
  test(`retains ${dialect} ternary operands through consequence repair`, async () => {
    await Parser.init();
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const [comment] of Comments) {
        let source = `const result = condition? ${comment} consequence : alternative;\n${Following}`;
        let tree = parser.parse(source)!;
        try {
          for (const [before, after] of [
            ['consequence', ''],
            ['', 'consequence'],
          ] as const) {
            const start = source.indexOf(comment) + comment.length + 1;
            const next = source.slice(0, start) + after + source.slice(start + before.length);
            const previous = tree;
            tree = compareEditedTree(
              parser,
              previous,
              next,
              new Edit({
                startIndex: start,
                oldEndIndex: start + before.length,
                newEndIndex: start + after.length,
                startPosition: position(source, start),
                oldEndPosition: position(source, start + before.length),
                newEndPosition: position(next, start + after.length),
              }),
              (incremental, fresh) => {
                for (const current of [incremental, fresh]) {
                  expect(current.rootNode.hasError, next).toBe(after === '');
                  const ternaries = current.rootNode.descendantsOfType('ternary_expression');
                  expect(ternaries, next).toHaveLength(1);
                  const ternary = ternaries[0]!;
                  expect(ternary.childForFieldName('condition')!.text, next).toBe('condition');
                  expect(ternary.childForFieldName('alternative')!.text, next).toBe('alternative');
                  const consequence = ternary.childForFieldName('consequence')!;
                  expect([consequence.text, consequence.isMissing], next).toEqual([after, after === '']);
                  expect(current.rootNode.lastNamedChild!.text, next).toBe(Following);
                  expect(current.rootNode.lastNamedChild!.hasError, next).toBe(false);
                }
              },
              true
            );
            previous.delete();
            source = next;
          }
        } finally {
          tree.delete();
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
