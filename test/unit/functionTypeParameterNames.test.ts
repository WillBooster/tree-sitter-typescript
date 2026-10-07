import fs from 'node:fs';
import path from 'node:path';

import { Edit, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { compareEditedTree, position } from '../helpers/treeEdit.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

const Source = fs.readFileSync(path.join(import.meta.dirname, '../fixtures/functionTypeParameterNames.ts'), 'utf8');

describe.each(['typescript', 'tsx'])('%s function-type parameter names', (dialect) => {
  let language: Awaited<ReturnType<typeof loadCurrentWasmBuild>>;
  let query: Query | undefined;
  beforeAll(async () => {
    await Parser.init();
    language = await loadCurrentWasmBuild(dialect);
    query = new Query(
      language,
      `
      [(required_parameter pattern: (pattern/identifier) @name)
       (optional_parameter pattern: (pattern/identifier) @name)]
      [(required_parameter type: (type_annotation (_) @type))
       (optional_parameter type: (type_annotation (_) @type))]
      (array (identifier) @reference)
      (pair value: (identifier) @reference)
      (primary_expression/identifier) @primary
    `
    );
  }, 30_000);
  afterAll(() => query?.delete());
  test.each(['unknown', 'never', 'unique'])(
    'retains %s annotation recovery when a block comment becomes an HTML line comment',
    (name) => {
      const parser = new Parser().setLanguage(language);
      const aliasQuery = new Query(
        language,
        '(type_alias_declaration name: (type_identifier) @name value: (_) @value)'
      );
      try {
        for (const marker of ['<!-- c -->', '--> c']) {
          let source = `type F = (${name}: /* c */ T) => void;`;
          let tree: Tree | undefined;
          try {
            tree = parser.parse(source)!;
            for (const replacement of [marker, '/* c */']) {
              const start = source.indexOf(':') + 2;
              const end = start + (source.includes('/* c */') ? 7 : marker.length);
              const next = source.slice(0, start) + replacement + source.slice(end);
              const previous = tree;
              tree = compareEditedTree(
                parser,
                previous,
                next,
                new Edit({
                  startIndex: start,
                  oldEndIndex: end,
                  newEndIndex: start + replacement.length,
                  startPosition: position(source, start),
                  oldEndPosition: position(source, end),
                  newEndPosition: position(next, start + replacement.length),
                }),
                (incremental, fresh) => {
                  for (const current of [incremental, fresh]) {
                    expect(current.rootNode.hasError).toBe(replacement === marker);
                    const valueStart = next.indexOf('('),
                      valueEnd = next.length - 1;
                    expect(
                      aliasQuery
                        .captures(current.rootNode)
                        .map(({ name, node }) => [name, node.type, node.text, node.startIndex, node.endIndex])
                    ).toEqual([
                      ['name', 'type_identifier', 'F', 5, 6],
                      ['value', 'function_type', next.slice(valueStart, valueEnd), valueStart, valueEnd],
                    ]);
                  }
                },
                true
              );
              previous.delete();
              source = next;
            }
          } finally {
            tree?.delete();
          }
        }
      } finally {
        aliasQuery.delete();
        parser.delete();
      }
    }
  );
  test.each(['unknown', 'never', 'unique'])(
    'retains %s operand recovery in object, tuple, generic and function types',
    (name) => {
      const parser = new Parser().setLanguage(language);
      const namesQuery = new Query(
        language,
        '[(required_parameter pattern: (identifier) @name) (optional_parameter pattern: (identifier) @name)]'
      );
      try {
        for (const optional of ['', '?']) {
          for (const [operator, operand] of [
            ['typeof', 'value'],
            ['keyof', 'Value'],
            ['readonly', 'Value[]'],
            ['infer', 'Value'],
          ] as const) {
            for (const template of [
              '{x: TYPE}',
              '[TYPE]',
              'A<TYPE>',
              '{[k:string]: TYPE}',
              '() => TYPE',
              'new () => TYPE',
              '{x:T | TYPE}',
              '(x: TYPE) => number',
            ]) {
              let source = `type F = (${name}${optional}: ${template.replace('TYPE', `${operator} ${operand}`)}) => number;`;
              let tree: Tree | undefined;
              try {
                tree = parser.parse(source)!;
                expect(tree.rootNode.hasError).toBe(false);
                for (const replacement of ['', '/* operand */', operand]) {
                  const start = source.indexOf(operator) + operator.length + 1;
                  const end =
                    start +
                    (source.slice(start).startsWith(operand)
                      ? operand.length
                      : source.slice(start).startsWith('/* operand */')
                        ? 13
                        : 0);
                  const next = source.slice(0, start) + replacement + source.slice(end);
                  const previous = tree;
                  tree = compareEditedTree(
                    parser,
                    previous,
                    next,
                    new Edit({
                      startIndex: start,
                      oldEndIndex: end,
                      newEndIndex: start + replacement.length,
                      startPosition: position(source, start),
                      oldEndPosition: position(source, end),
                      newEndPosition: position(next, start + replacement.length),
                    }),
                    (incremental, fresh) => {
                      for (const current of [incremental, fresh]) {
                        expect(current.rootNode.hasError).toBe(replacement !== operand);
                        const start = next.indexOf(name);
                        expect(
                          namesQuery
                            .captures(current.rootNode)
                            .filter(({ node }) => node.text === name)
                            .map(({ node }) => [node.text, node.startIndex, node.endIndex])
                        ).toEqual(replacement === operand ? [[name, start, start + name.length]] : []);
                      }
                    },
                    true
                  );
                  previous.delete();
                  source = next;
                }
              } finally {
                tree?.delete();
              }
            }
          }
        }
      } finally {
        namesQuery.delete();
        parser.delete();
      }
    }
  );
  test.each(['unknown', 'never', 'unique'])(
    'retains %s operator recovery at union and conditional operand positions',
    (name) => {
      const parser = new Parser().setLanguage(language);
      const parameterQuery = new Query(
        language,
        `
        [(required_parameter pattern: (identifier) @name type: (type_annotation) @annotation)
         (optional_parameter pattern: (identifier) @name type: (type_annotation) @annotation)]
      `
      );
      try {
        for (const optional of ['', '?']) {
          for (const wrapper of ['', '(', '((']) {
            for (const type of [
              'T | typeof value',
              'T & typeof value',
              'T extends U ? typeof value : X',
              'T extends U ? X : typeof value',
              'T extends typeof value ? X : Y',
            ]) {
              let source = `type F = (${name}${optional}: ${wrapper}${type}${')'.repeat(wrapper.length)}) => number;`;
              let tree: Tree | undefined;
              try {
                tree = parser.parse(source)!;
                check(tree, source, false);
                for (const replacement of ['', '/* operand */', 'value']) {
                  const start = source.indexOf('typeof ') + 7;
                  const end = source.includes('value')
                    ? start + 5
                    : source.includes('/* operand */')
                      ? start + 13
                      : start;
                  const next = source.slice(0, start) + replacement + source.slice(end);
                  const previous = tree;
                  tree = compareEditedTree(
                    parser,
                    previous,
                    next,
                    new Edit({
                      startIndex: start,
                      oldEndIndex: end,
                      newEndIndex: start + replacement.length,
                      startPosition: position(source, start),
                      oldEndPosition: position(source, end),
                      newEndPosition: position(next, start + replacement.length),
                    }),
                    (incremental, fresh) => {
                      check(incremental, next, replacement !== 'value');
                      check(fresh, next, replacement !== 'value');
                    },
                    true
                  );
                  previous.delete();
                  source = next;
                }
                function check(current: Tree, text: string, missing: boolean): void {
                  expect(current.rootNode.hasError).toBe(missing);
                  const start = text.indexOf(name),
                    annotation = text.indexOf(':'),
                    end = text.indexOf(') =>');
                  expect(
                    parameterQuery
                      .captures(current.rootNode)
                      .map(({ name, node }) => [name, node.text, node.startIndex, node.endIndex])
                  ).toEqual(
                    missing
                      ? []
                      : [
                          ['name', name, start, start + name.length],
                          ['annotation', text.slice(annotation, end), annotation, end],
                        ]
                  );
                }
              } finally {
                tree?.delete();
              }
            }
          }
        }
      } finally {
        parameterQuery.delete();
        parser.delete();
      }
    }
  );
  test.each(['unknown', 'never', 'unique'])(
    'retains %s type-operator recovery through operand removal and restoration',
    (name) => {
      const parser = new Parser().setLanguage(language);
      const aliasQuery = new Query(
        language,
        '(type_alias_declaration name: (type_identifier) @name value: (_) @value)'
      );
      try {
        for (const optional of ['', '?']) {
          for (const [operator, operand] of [
            ['typeof', 'value'],
            ['keyof', 'Value'],
            ['readonly', 'Value[]'],
            ['infer', 'Value'],
          ] as const) {
            let source = `type F = (${name}${optional}: ${operator} ${operand}) => number;`;
            let tree: Tree | undefined;
            try {
              tree = parser.parse(source)!;
              check(tree, source, false);
              for (const replacement of ['', '/* operand */', operand]) {
                const start = source.indexOf(operator) + operator.length + 1;
                const end = source.indexOf(') =>');
                const next = source.slice(0, start) + replacement + source.slice(end);
                const previous = tree;
                tree = compareEditedTree(
                  parser,
                  previous,
                  next,
                  new Edit({
                    startIndex: start,
                    oldEndIndex: end,
                    newEndIndex: start + replacement.length,
                    startPosition: position(source, start),
                    oldEndPosition: position(source, end),
                    newEndPosition: position(next, start + replacement.length),
                  }),
                  (incremental, fresh) => {
                    check(incremental, next, replacement !== operand);
                    check(fresh, next, replacement !== operand);
                  },
                  true
                );
                previous.delete();
                source = next;
              }
              function check(current: Tree, text: string, missing: boolean): void {
                expect(current.rootNode.hasError).toBe(missing);
                const parenthesized = missing && name === 'unknown' && operator !== 'readonly';
                const end = parenthesized ? text.indexOf(') =>') + 1 : text.length - 1;
                expect(
                  aliasQuery
                    .captures(current.rootNode)
                    .map(({ name, node }) => [name, node.type, node.text, node.startIndex, node.endIndex])
                ).toEqual([
                  ['name', 'type_identifier', 'F', 5, 6],
                  ['value', parenthesized ? 'parenthesized_type' : 'function_type', text.slice(9, end), 9, end],
                ]);
                if (missing && operator === 'readonly') {
                  const parameter = current.rootNode.descendantsOfType('required_parameter')[0]!;
                  const pattern = parameter.childForFieldName('pattern')!;
                  expect(pattern.text).toBe(operator);
                  expect(pattern.startIndex).toBe(text.indexOf(operator));
                  expect(pattern.endIndex).toBe(text.indexOf(operator) + operator.length);
                } else if (missing) {
                  expect(current.rootNode.descendantsOfType(['required_parameter', 'optional_parameter'])).toHaveLength(
                    0
                  );
                }
              }
            } finally {
              tree?.delete();
            }
          }
        }
      } finally {
        aliasQuery.delete();
        parser.delete();
      }
    }
  );
  test.each(['unknown', 'never', 'unique'])('retains %s nested type-query recovery through operand edits', (name) => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const optional of ['', '?']) {
        for (const wrapper of ['(', '((']) {
          let source = `type F = (${name}${optional}: ${wrapper}typeof value${')'.repeat(wrapper.length)}) => number;`;
          let tree: Tree | undefined;
          try {
            tree = parser.parse(source)!;
            check(tree, source, false);
            for (const replacement of ['', '/* operand */', 'value']) {
              const start = source.indexOf('typeof ') + 7;
              const end = source.indexOf(')', start);
              const next = source.slice(0, start) + replacement + source.slice(end);
              const previous = tree;
              tree = compareEditedTree(
                parser,
                previous,
                next,
                new Edit({
                  startIndex: start,
                  oldEndIndex: end,
                  newEndIndex: start + replacement.length,
                  startPosition: position(source, start),
                  oldEndPosition: position(source, end),
                  newEndPosition: position(next, start + replacement.length),
                }),
                (incremental, fresh) => {
                  check(incremental, next, replacement !== 'value');
                  check(fresh, next, replacement !== 'value');
                },
                true
              );
              previous.delete();
              source = next;
            }
            function check(current: Tree, text: string, missing: boolean): void {
              expect(current.rootNode.hasError).toBe(missing);
              const alias = current.rootNode.descendantsOfType('type_alias_declaration')[0]!;
              expect(alias.childForFieldName('name')!.text).toBe('F');
              const value = alias.childForFieldName('value')!;
              expect(value.type).toBe('function_type');
              expect(value.text).toBe(text.slice(9, -1));
              expect(value.startIndex).toBe(9);
              expect(value.endIndex).toBe(text.length - 1);
              const parameters = value.childForFieldName('parameters')!;
              const parameter = parameters.descendantsOfType(
                missing ? 'required_parameter' : optional ? 'optional_parameter' : 'required_parameter'
              )[0]!;
              const pattern = parameter.childForFieldName('pattern')!;
              const start = missing ? text.indexOf(wrapper + 'typeof') : text.indexOf(name);
              const end = missing ? text.indexOf(') =>') : start + name.length;
              expect(pattern.type).toBe(missing ? 'parenthesized_expression' : 'identifier');
              expect(pattern.text).toBe(text.slice(start, end));
              expect(pattern.startIndex).toBe(start);
              expect(pattern.endIndex).toBe(end);
            }
          } finally {
            tree?.delete();
          }
        }
      }
    } finally {
      parser.delete();
    }
  });
  test.each(['unknown', 'never', 'unique'])(
    'retains %s callback bodies through conditional and colon edits',
    (name) => {
      const parser = new Parser().setLanguage(language);
      try {
        for (const optional of ['', '?']) {
          let source = `const fn = (${name}${optional}: number) => x;`;
          let tree: Tree | undefined;
          try {
            tree = parser.parse(source)!;
            for (const body of [
              'x ? y : z',
              'x ?? y',
              'x?.y',
              'x?.1 : y',
              'unique',
              '(x: number) => x',
              '({x: y})',
              '(x < y) ? x : y',
              'x < y ? x : y',
              '/x:y/.test(x)',
              'foo("x:y")',
              'x ? y ? y : z : z',
              'x ?? (y ? z : x)',
              'x',
            ]) {
              const start = source.indexOf(' => ') + 4;
              const end = source.length - 1;
              const next = source.slice(0, start) + body + ';';
              const previous = tree;
              tree = compareEditedTree(
                parser,
                previous,
                next,
                new Edit({
                  startIndex: start,
                  oldEndIndex: end,
                  newEndIndex: start + body.length,
                  startPosition: position(source, start),
                  oldEndPosition: position(source, end),
                  newEndPosition: position(next, start + body.length),
                }),
                (incremental, fresh) => {
                  check(incremental, next, body);
                  check(fresh, next, body);
                }
              );
              previous.delete();
              source = next;
            }
            function check(current: Tree, text: string, body: string): void {
              expect(current.rootNode.hasError).toBe(false);
              const arrow = current.rootNode.descendantsOfType('arrow_function')[0]!;
              const parameter = arrow.childForFieldName('parameters')!.namedChildren[0]!;
              const pattern = parameter.childForFieldName('pattern')!;
              expect(pattern.type).toBe('identifier');
              expect(pattern.text).toBe(name);
              expect(pattern.startIndex).toBe(text.indexOf(name));
              expect(pattern.endIndex).toBe(text.indexOf(name) + name.length);
              const result = arrow.childForFieldName('body')!;
              expect(result.text).toBe(body);
              expect(result.startIndex).toBe(text.indexOf(' => ') + 4);
              expect(result.endIndex).toBe(text.length - 1);
            }
          } finally {
            tree?.delete();
          }
        }
      } finally {
        parser.delete();
      }
    }
  );
  test.each(['unknown', 'never', 'unique'])('retains %s optional extra-colon recovery through type edits', (name) => {
    const parser = new Parser().setLanguage(language);
    const parameterQuery = new Query(
      language,
      `
      [(required_parameter pattern: (identifier) @name type: (type_annotation (predefined_type) @type))
       (optional_parameter pattern: (identifier) @name type: (type_annotation (predefined_type) @type))]
    `
    );
    let source = `type F = (${name}?: number) => void;`;
    let tree: Tree | undefined;
    try {
      tree = parser.parse(source)!;
      check(tree, source, false);
      for (const [before, after, extraColon] of [
        ['number', 'x: number', true],
        [') =>', ', m: string) =>', true],
        ['x: number', 'number', false],
        [', m: string', '', false],
      ] as const) {
        const start = source.indexOf(before);
        expect(start).toBeGreaterThanOrEqual(0);
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
            check(incremental, next, extraColon);
            check(fresh, next, extraColon);
          },
          true
        );
        previous.delete();
        source = next;
      }
      function check(current: Tree, text: string, extraColon: boolean): void {
        expect(current.rootNode.hasError).toBe(extraColon);
        const firstName = extraColon ? 'x' : name;
        const start = extraColon ? text.indexOf('x: number') : text.indexOf(name);
        const type = text.indexOf('number');
        const expected: (string | number)[][] = [
          ['name', firstName, start, start + firstName.length],
          ['type', 'number', type, type + 6],
        ];
        if (text.includes('m: string')) {
          const m = text.indexOf('m: string');
          const type = text.indexOf('string');
          expected.push(['name', 'm', m, m + 1], ['type', 'string', type, type + 6]);
        }
        expect(
          parameterQuery
            .captures(current.rootNode)
            .map(({ name, node }) => [name, node.text, node.startIndex, node.endIndex])
        ).toEqual(expected);
        expect(current.rootNode.descendantsOfType('optional_parameter')).toHaveLength(extraColon ? 0 : 1);
      }
    } finally {
      tree?.delete();
      parameterQuery.delete();
      parser.delete();
    }
  });
  test.each(['unknown', 'never', 'unique'])(
    'retains %s optional callback recovery through return-type edits',
    (name) => {
      const parser = new Parser().setLanguage(language);
      const aliasQuery = new Query(
        language,
        '(type_alias_declaration name: (type_identifier) @name value: (_) @value)'
      );
      let source = `type F = (${name}?: number) => unknown;`;
      let tree: Tree | undefined;
      try {
        tree = parser.parse(source)!;
        check(tree, source, false);
        for (const [before, after, missing] of [
          ['=> unknown;', '=>;', true],
          ['=>;', '=> /* return */ ;', true],
          ['=> /* return */ ;', '=> unknown;', false],
        ] as const) {
          const start = source.indexOf(before);
          expect(start).toBeGreaterThanOrEqual(0);
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
              check(incremental, next, missing);
              check(fresh, next, missing);
            },
            true
          );
          previous.delete();
          source = next;
        }
        function check(current: Tree, text: string, missing: boolean): void {
          expect(current.rootNode.hasError).toBe(missing);
          const end = missing ? text.lastIndexOf(')') + 1 : text.length - 1;
          expect(
            aliasQuery
              .captures(current.rootNode)
              .map(({ name, node }) => [name, node.type, node.text, node.startIndex, node.endIndex])
          ).toEqual([
            ['name', 'type_identifier', 'F', 5, 6],
            ['value', missing ? 'parenthesized_type' : 'function_type', text.slice(9, end), 9, end],
          ]);
        }
      } finally {
        tree?.delete();
        aliasQuery.delete();
        parser.delete();
      }
    }
  );
  test.each(['unknown', 'never', 'unique'])('retains %s optional callback ownership through arrow edits', (name) => {
    const parser = new Parser().setLanguage(language);
    const aliasQuery = new Query(language, '(type_alias_declaration name: (type_identifier) @name value: (_) @value)');
    let source = `type F = (${name}?: number) => unknown;`;
    let tree: Tree | undefined;
    try {
      tree = parser.parse(source)!;
      check(tree, source, false);
      for (const [before, after, error] of [
        [' => unknown', '', true],
        [');', ') => unknown;', false],
        ['number', '() => number', false],
        [' => unknown', '', true],
        [');', ') => unknown;', false],
        ['() => number', 'number', false],
      ] as const) {
        const start = source.indexOf(before);
        expect(start).toBeGreaterThanOrEqual(0);
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
            check(incremental, next, error);
            check(fresh, next, error);
          },
          true
        );
        previous.delete();
        source = next;
      }
      function check(current: Tree, text: string, error: boolean): void {
        expect(current.rootNode.hasError).toBe(error);
        const captures = aliasQuery.captures(current.rootNode);
        expect(captures.map(({ name, node }) => [name, node.text, node.startIndex, node.endIndex])).toEqual([
          ['name', 'F', 5, 6],
          ['value', text.slice(9, -1), 9, text.length - 1],
        ]);
        expect(captures[1]!.node.type).toBe(error ? 'parenthesized_type' : 'function_type');
      }
    } finally {
      tree?.delete();
      aliasQuery.delete();
      parser.delete();
    }
  });
  test('retains index-signature fields through name and trivia edits', () => {
    const parser = new Parser().setLanguage(language);
    const indexQuery = new Query(
      language,
      '(index_signature name: (identifier) @name index_type: (_) @index type: (type_annotation (_) @result))'
    );
    let source =
      'interface I { [unknown: string]: number; }\nclass C { [unique: string]: number; }\ntype T = { readonly [never: string]: number };';
    let tree: Tree | undefined;
    try {
      tree = parser.parse(source)!;
      check(tree, source, 'unknown');
      for (const [before, after, name] of [
        ['unknown', 'value', 'value'],
        ['value', 'never', 'never'],
        ['never:', 'never /* key */:', 'never'],
        ['never /* key */:', 'never:', 'never'],
        ['never:', 'unknown:', 'unknown'],
      ] as const) {
        const start = source.indexOf(before);
        expect(start).toBeGreaterThanOrEqual(0);
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
            check(incremental, next, name);
            check(fresh, next, name);
          }
        );
        previous.delete();
        source = next;
      }
      function check(current: Tree, text: string, firstName: string): void {
        expect(current.rootNode.hasError).toBe(false);
        const expected = [firstName, 'unique', 'never'].flatMap((name, i) => {
          const start = text.indexOf('[' + name, i === 2 ? text.indexOf('type T') : 0) + 1;
          const index = text.indexOf('string', start),
            result = text.indexOf('number', index);
          return [
            ['name', name, start, start + name.length],
            ['index', 'string', index, index + 6],
            ['result', 'number', result, result + 6],
          ];
        });
        expect(
          indexQuery
            .captures(current.rootNode)
            .map(({ name, node }) => [name, node.text, node.startIndex, node.endIndex])
        ).toEqual(expected);
      }
    } finally {
      tree?.delete();
      indexQuery.delete();
      parser.delete();
    }
  });
  test.each(['unknown', 'never', 'unique'])(
    'retains %s initializer ownership through nested-type arrow edits',
    (name) => {
      const parser = new Parser().setLanguage(language);
      const valueQuery = new Query(language, '(variable_declarator value: (parenthesized_expression) @value)');
      let source = `const x = (${name}: (x: number) => number);`;
      let tree: Tree | undefined;
      try {
        tree = parser.parse(source)!;
        check(tree, source, false);
        for (const [before, after, error] of [
          [' => number', '', true],
          ['(x: number)', '((x: number))', true],
          ['((x: number))', '(x: number) => number', false],
          ['(x: number) => number', '(unique: number) => number', false],
          ['(unique: number) => number', '(x: number) => number', false],
          ['(x: number) => number', '() => number', false],
          ['() => number', '()', true],
          ['()', '(x: number) => number', false],
        ] as const) {
          const start = source.indexOf(before);
          expect(start).toBeGreaterThanOrEqual(0);
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
              check(incremental, next, error);
              check(fresh, next, error);
            },
            true
          );
          previous.delete();
          source = next;
        }
        function check(current: Tree, text: string, error: boolean): void {
          expect(current.rootNode.hasError).toBe(error);
          const start = text.indexOf('(');
          expect(
            valueQuery.captures(current.rootNode).map(({ node }) => [node.text, node.startIndex, node.endIndex])
          ).toEqual([[text.slice(start, -1), start, text.length - 1]]);
        }
      } finally {
        tree?.delete();
        valueQuery.delete();
        parser.delete();
      }
    }
  );
  test('retains malformed parenthesized-type ownership through arrow edits', () => {
    const parser = new Parser().setLanguage(language);
    const recoveryQuery = new Query(
      language,
      '(type_alias_declaration name: (type_identifier) @name value: (_) @value)'
    );
    let source = 'type T = (unknown: unknown);';
    let tree: Tree | undefined;
    try {
      tree = parser.parse(source)!;
      check(tree, source, 'parenthesized_type');
      for (const [before, after, kind] of [
        [');', ') & (never: never);', 'intersection_type'],
        [') & (never: never);', ') | undefined;', 'union_type'],
        [') | undefined;', ') => void;', 'function_type'],
        [') => void;', ');', 'parenthesized_type'],
      ] as const) {
        const start = source.indexOf(before);
        expect(start).toBeGreaterThanOrEqual(0);
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
            check(incremental, next, kind);
            check(fresh, next, kind);
          },
          true
        );
        previous.delete();
        source = next;
      }
      function check(current: Tree, text: string, kind: string): void {
        expect(current.rootNode.hasError).toBe(kind !== 'function_type');
        const start = text.indexOf('(');
        expect(
          recoveryQuery
            .captures(current.rootNode)
            .map(({ name, node }) => [name, node.type, node.text, node.startIndex, node.endIndex])
        ).toEqual([
          ['name', 'type_identifier', 'T', text.indexOf('T'), text.indexOf('T') + 1],
          ['value', kind, text.slice(start, -1), start, text.length - 1],
        ]);
      }
    } finally {
      tree?.delete();
      recoveryQuery.delete();
      parser.delete();
    }
  });
  test('retains the initializer while an incomplete unique type is edited', () => {
    const parser = new Parser().setLanguage(language);
    const recoveryQuery = new Query(language, '(variable_declarator value: (parenthesized_expression) @value)');
    let source = 'const a = (unique: unique<A>);';
    let tree: Tree | undefined;
    try {
      tree = parser.parse(source)!;
      check(tree, source, true);
      for (const [before, after, error] of [
        ['unique<A>', 'unique symbol', false],
        ['unique symbol', 'unique<A>', true],
      ] as const) {
        const start = source.indexOf(before);
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
            check(incremental, next, error);
            check(fresh, next, error);
          },
          true
        );
        previous.delete();
        source = next;
      }
      function check(current: Tree, text: string, error: boolean): void {
        expect(current.rootNode.hasError).toBe(error);
        const start = text.indexOf('(');
        expect(
          recoveryQuery.captures(current.rootNode).map(({ node }) => [node.text, node.startIndex, node.endIndex])
        ).toEqual([[text.slice(start, -1), start, text.length - 1]]);
      }
    } finally {
      tree?.delete();
      recoveryQuery.delete();
      parser.delete();
    }
  });
  test('preserves the type field after extra-colon edits', () => {
    const parser = new Parser().setLanguage(language);
    const recoveryQuery = new Query(language, '(parenthesized_expression type: (type_annotation) @annotation)');
    let source = 'const x = (unknown: x: number);';
    let tree: Tree | undefined;
    try {
      tree = parser.parse(source)!;
      check(tree, source, ': number');
      for (const [before, after, annotation] of [
        [': x: number', ': x', ': x'],
        [': x', ': x: number', ': number'],
        ['unknown', 'never', ': number'],
        ['never', 'unknown', ': number'],
      ]) {
        const start = source.indexOf(before!);
        const next = source.slice(0, start) + after + source.slice(start + before!.length);
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex: start,
            oldEndIndex: start + before!.length,
            newEndIndex: start + after!.length,
            startPosition: position(source, start),
            oldEndPosition: position(source, start + before!.length),
            newEndPosition: position(next, start + after!.length),
          }),
          (incremental, fresh) => {
            check(incremental, next, annotation!);
            check(fresh, next, annotation!);
          },
          true
        );
        previous.delete();
        source = next;
      }
      function check(current: Tree, text: string, annotation: string): void {
        expect(current.rootNode.hasError).toBe(annotation === ': number');
        const start = text.lastIndexOf(annotation);
        expect(
          recoveryQuery.captures(current.rootNode).map(({ node }) => [node.text, node.startIndex, node.endIndex])
        ).toEqual([[annotation, start, start + annotation.length]]);
      }
    } finally {
      tree?.delete();
      recoveryQuery.delete();
      parser.delete();
    }
  });
  test.each(['unknown', 'never', 'unique'])('retains the annotated %s expression through arrow edits', (name) => {
    const parser = new Parser().setLanguage(language);
    const roleQuery = new Query(
      language,
      `
      (labeled_statement label: (statement_identifier) @label)
      (parenthesized_expression (identifier) @expression_name)
      (primary_expression/identifier) @primary
      (parenthesized_expression type: (type_annotation (predefined_type) @type))
      (required_parameter pattern: (pattern/identifier) @binding_name
        type: (type_annotation (predefined_type) @type))
    `
    );
    let source = `${name}: { const x = (${name} /* annotation */: number); }`;
    let tree: Tree | undefined;
    try {
      tree = parser.parse(source)!;
      check(tree, source, 'expression_name');
      for (const [before, after, role, error] of [
        [';', ` => ${name};`, 'binding_name', false],
        [` => ${name};`, ';', 'expression_name', false],
        ['number', '', 'expression_name', true],
        [': );', ': number);', 'expression_name', false],
      ] as const) {
        const start = source.indexOf(before);
        expect(start).toBeGreaterThanOrEqual(0);
        const next = source.slice(0, start) + after + source.slice(start + before.length);
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex: start,
            oldEndIndex: start + before!.length,
            newEndIndex: start + after!.length,
            startPosition: position(source, start),
            oldEndPosition: position(source, start + before!.length),
            newEndPosition: position(next, start + after!.length),
          }),
          (incremental, fresh) => {
            check(incremental, next, role, error);
            check(fresh, next, role, error);
          },
          error
        );
        previous.delete();
        source = next;
      }
      function check(current: Tree, text: string, role: string, error = false): void {
        expect(current.rootNode.hasError).toBe(error);
        const nameStart = text.indexOf(name, text.indexOf('('));
        const typeStart = text.indexOf('number');
        expect(
          roleQuery
            .captures(current.rootNode)
            .filter(({ name }) => name !== 'primary')
            .map(({ name, node }) => [name, node.text, node.startIndex, node.endIndex])
        ).toEqual([
          ['label', name, 0, name.length],
          [role, name, nameStart, nameStart + name.length],
          ...(typeStart === -1 ? [] : [['type', 'number', typeStart, typeStart + 'number'.length]]),
        ]);
        if (role === 'expression_name') {
          expect(
            roleQuery
              .captures(current.rootNode)
              .some(
                ({ name: capture, node }) =>
                  capture === 'primary' && node.startIndex === nameStart && node.endIndex === nameStart + name.length
              )
          ).toBe(true);
        }
      }
    } finally {
      tree?.delete();
      roleQuery.delete();
      parser.delete();
    }
  });
  test('retains the type alias result through invalid constructor bindings', () => {
    const parser = new Parser().setLanguage(language);
    const recoveryQuery = new Query(
      language,
      '[(type_alias_declaration value: (predefined_type) @result) (type_alias_declaration value: (constructor_type type: (predefined_type) @result))]'
    );
    let source = 'type F = new (void: T[]) => unknown;';
    let tree: Tree | undefined;
    try {
      tree = parser.parse(source)!;
      check(tree, source);
      const start = source.indexOf('void');
      for (const [before, after] of [
        ['void', 'value'],
        ['value', 'void'],
        ['void', '#unknown'],
        ['#unknown', 'void'],
      ]) {
        const next = source.slice(0, start) + after + source.slice(start + before!.length);
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex: start,
            oldEndIndex: start + before!.length,
            newEndIndex: start + after!.length,
            startPosition: position(source, start),
            oldEndPosition: position(source, start + before!.length),
            newEndPosition: position(next, start + after!.length),
          }),
          (incremental, fresh) => {
            check(incremental, next);
            check(fresh, next);
          },
          true
        );
        previous.delete();
        expect(tree.rootNode.hasError).toBe(after !== 'value');
        source = next;
      }
      function check(current: Tree, text: string): void {
        const start = text.lastIndexOf('unknown');
        expect(
          recoveryQuery.captures(current.rootNode).map(({ node }) => [node.text, node.startIndex, node.endIndex])
        ).toEqual([['unknown', start, start + 'unknown'.length]]);
      }
    } finally {
      tree?.delete();
      recoveryQuery.delete();
      parser.delete();
    }
  });
  test.each([
    '(unknown: unknown)',
    '(never: never)',
    '(unique: unknown)',
    '(unknown?: number',
    ', never?: string,',
    ', unique?: string) => string',
    '[unknown,',
    ', never,',
    ', unique];',
    'unknown /* binding',
    'never /* optional',
    'unique // binding',
  ])('preserves %s name and type through edits', (marker) => {
    const parser = new Parser().setLanguage(language);
    let tree: Tree | undefined;
    let source = Source;
    try {
      tree = parser.parse(source)!;
      check(tree, source);
      const word = marker.includes('unique') ? 'unique' : marker.includes('unknown') ? 'unknown' : 'never';
      const markerStart = source.indexOf(marker);
      expect(markerStart).toBeGreaterThanOrEqual(0);
      const start = markerStart + marker.indexOf(word);
      for (const [before, after] of [
        [word, 'parameter'],
        ['parameter', word],
      ]) {
        const next = source.slice(0, start) + after + source.slice(start + before!.length);
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex: start,
            oldEndIndex: start + before!.length,
            newEndIndex: start + after!.length,
            startPosition: position(source, start),
            oldEndPosition: position(source, start + before!.length),
            newEndPosition: position(next, start + after!.length),
          }),
          (incremental, fresh) => {
            check(incremental, next);
            check(fresh, next);
          }
        );
        previous.delete();
        source = next;
      }
      expect(source).toBe(Source);
      function check(current: Tree, text: string): void {
        const reference = ts.createSourceFile('parameters.ts', text, ts.ScriptTarget.Latest, true);
        const expected: [string, string, number, number][] = [];
        const visit = (node: ts.Node): void => {
          if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
            expected.push(['name', node.name.getText(reference), node.name.getStart(reference), node.name.getEnd()]);
            if (node.type)
              expected.push(['type', node.type.getText(reference), node.type.getStart(reference), node.type.getEnd()]);
          }
          if (
            ts.isIdentifier(node) &&
            (ts.isArrayLiteralExpression(node.parent) ||
              (ts.isPropertyAssignment(node.parent) && node.parent.initializer === node))
          ) {
            expected.push(['reference', node.getText(reference), node.getStart(reference), node.getEnd()]);
          }
          ts.forEachChild(node, visit);
        };
        visit(reference);
        expect(current.rootNode.hasError).toBe(false);
        const captures = query!.captures(current.rootNode);
        expect(
          captures
            .filter(({ name }) => name !== 'primary')
            .map(({ name, node }) => [name, node.text, node.startIndex, node.endIndex])
        ).toEqual(expected);
        for (const reference of captures.filter(({ name }) => name === 'reference')) {
          expect(
            captures.some(
              ({ name, node }) =>
                name === 'primary' &&
                node.startIndex === reference.node.startIndex &&
                node.endIndex === reference.node.endIndex
            )
          ).toBe(true);
        }
      }
    } finally {
      tree?.delete();
      parser.delete();
    }
  });
});
