import fs from 'node:fs';

import { Edit, Parser, Query, type Node, type Tree } from '@willbooster/web-tree-sitter';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import configuration from '../../tree-sitter.json';
import { compareEditedTree, position } from '../helpers/treeEdit.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

describe.each(['typescript', 'tsx'])('%s untyped function-type parameter names', (dialect) => {
  let language: Awaited<ReturnType<typeof loadCurrentWasmBuild>>;
  let queries: Query[] = [];

  beforeAll(async () => {
    await Parser.init();
    language = await loadCurrentWasmBuild(dialect);
    const grammar = configuration.grammars.find((entry) => entry.name === dialect)!;
    queries = (['highlights', 'tags', 'locals', 'injections'] as const).map(
      (kind) =>
        new Query(
          language,
          [grammar[kind]]
            .flat()
            .map((file: string) => fs.readFileSync(file, 'utf8'))
            .join('\n')
        )
    );
  }, 30_000);
  afterAll(() => {
    for (const query of queries) query.delete();
  });

  test.each(['unknown', 'never', 'unique'])('does not claim incomplete untyped headers for %s', (name) => {
    const parser = new Parser().setLanguage(language);
    const bindings = new Query(language, '(required_parameter pattern: (pattern/identifier) @name)');
    try {
      for (const continuation of ['=>', 'number', ')']) {
        let source = `type F=(${name})=>number;`;
        let tree: Tree | undefined = parser.parse(source)!;
        const start = source.indexOf(continuation);
        let previous = continuation;
        try {
          const incomplete =
            continuation === 'number'
              ? [
                  '',
                  '!',
                  '~',
                  '%',
                  '^',
                  '@',
                  '#',
                  '+',
                  '-',
                  '.',
                  String.raw`\x`,
                  '|',
                  '&',
                  'keyof',
                  'typeof',
                  'readonly',
                  'infer',
                  'unique',
                  '()',
                  'asserts import',
                  'asserts new',
                  'x is import',
                  'infer import',
                  '(x:T)=>new',
                  '(x:T)=>import',
                  'number import "x"',
                  'number /* same line */ import "x"',
                  'T |',
                  'T &',
                  'x is',
                  'asserts',
                  'T extends U ?',
                  'T extends U ? T :',
                  'T extends U ? T',
                  'a?.b',
                  'a ?.b',
                  'a?.b ? c : d',
                  'T extends U ? a?.b:c',
                  'new',
                  'new /* incomplete */',
                  'abstract new',
                  'import',
                  'import /* incomplete */',
                  '"abc',
                  "'abc",
                  '`abc',
                ]
              : continuation === ')'
                ? [
                    ',,)',
                    ', /* missing parameter */ ,)',
                    ', other:T,,)',
                    ', ?)',
                    ', 1)',
                    ', :x)',
                    ', .)',
                    ', ..)',
                    ', ...)',
                    ', ... /* missing */ )',
                  ]
                : [''];
          for (const replacement of [...incomplete, continuation]) {
            const next = source.slice(0, start) + replacement + source.slice(start + previous.length);
            const previousTree = tree;
            tree = undefined;
            try {
              tree = compareEditedTree(
                parser,
                previousTree,
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
                  expect(incremental.rootNode.hasError).toBe(replacement !== continuation);
                  expect(
                    bindings
                      .captures(incremental.rootNode)
                      .filter(({ node }) => node.text === name)
                      .map(({ node }) => node.text)
                  ).toEqual(replacement !== continuation ? [] : [name]);
                  for (const query of queries) {
                    expect(
                      query.captures(incremental.rootNode).map(({ name, node }) => [name, snapshot(node)])
                    ).toEqual(query.captures(fresh.rootNode).map(({ name, node }) => [name, snapshot(node)]));
                  }
                },
                true
              );
            } finally {
              previousTree.delete();
            }
            source = next;
            previous = replacement;
          }
        } finally {
          tree?.delete();
        }
      }
    } finally {
      bindings.delete();
      parser.delete();
    }
  });

  test.each(['unknown', 'never', 'unique'])(
    'retains bindings in conditional types and return statement boundaries for %s',
    (name) => {
      const parser = new Parser().setLanguage(language);
      try {
        for (const source of [
          `type F<T> = T extends (${name})=>number ? true:false;`,
          `type F<T> = T extends (${name})=>infer R ? R:never;`,
          `type F=(${name})=>new()=>T;`,
          `type F=(${name})=>abstract new()=>T;`,
          `type F=(${name})=>import("x").T;`,
          `type F=(${name})=>number\n/foo/.test("");`,
          `type F=(${name})=>abstract\nnumber;`,
          `type F=(${name})=>number\nimport "x";`,
          `type F=(${name})=>abstract\nimport "x";`,
          `type F=(${name})=>(number)\nimport {x} from "x";`,
        ]) {
          const ordinary = source.replace(name, 'x'.repeat(name.length));
          const actual = parser.parse(source)!;
          const reference = parser.parse(ordinary)!;
          try {
            expect(actual.rootNode.hasError).toBe(false);
            expect(snapshot(actual.rootNode)).toEqual(snapshot(reference.rootNode));
            for (const query of queries) {
              expect(query.captures(actual.rootNode).map(({ name, node }) => [name, snapshot(node)])).toEqual(
                query.captures(reference.rootNode).map(({ name, node }) => [name, snapshot(node)])
              );
            }
          } finally {
            actual.delete();
            reference.delete();
          }
        }
      } finally {
        parser.delete();
      }
    }
  );

  test.each(['unknown', 'never', 'unique'])('retains contextual type operands and edits for %s', (name) => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const generic of ['', '<T>']) {
        for (const optional of ['', '?']) {
          for (const result of [
            'is',
            'T | is',
            'T & is',
            'x is is',
            'asserts is',
            'asserts x is is',
            'keyof is',
            'typeof is',
            'infer is',
            'readonly is[]',
            'T extends U ? T:is',
            '(x:T)=>is',
            'keyof asserts',
            'typeof infer',
            'infer keyof',
            'extends',
            'T | extends',
            'x is extends',
            'typeof extends',
            'infer extends',
            'T extends extends ? T:extends',
            '(x:T)=>extends',
          ]) {
            for (const trivia of ['', ' /* c */ ', '\n']) {
              let source = `type is=number;type F=${generic}(${name}${optional})=>${trivia}${result};`;
              let tree: Tree | undefined = parser.parse(source)!;
              const reference = parser.parse(source.replace(name, 'x'.repeat(name.length)))!;
              const target = result.endsWith('extends')
                ? 'extends'
                : result.includes('is')
                  ? 'is'
                  : result.split(' ').at(-1)!;
              const start = source.lastIndexOf(target);
              let previous = target;
              try {
                expect(tree.rootNode.hasError, source).toBe(false);
                expect(snapshot(tree.rootNode), source).toEqual(snapshot(reference.rootNode));
                for (const query of queries) {
                  expect(query.captures(tree.rootNode).map(({ name, node }) => [name, snapshot(node)])).toEqual(
                    query.captures(reference.rootNode).map(({ name, node }) => [name, snapshot(node)])
                  );
                }
                const initialSnapshot = snapshot(tree.rootNode);
                for (const replacement of ['Result', target]) {
                  const next = source.slice(0, start) + replacement + source.slice(start + previous.length);
                  const previousTree = tree;
                  tree = undefined;
                  try {
                    tree = compareEditedTree(
                      parser,
                      previousTree,
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
                        for (const query of queries) {
                          expect(
                            query.captures(incremental.rootNode).map(({ name, node }) => [name, snapshot(node)])
                          ).toEqual(query.captures(fresh.rootNode).map(({ name, node }) => [name, snapshot(node)]));
                        }
                      }
                    );
                  } finally {
                    previousTree.delete();
                  }
                  source = next;
                  previous = replacement;
                }
                expect(snapshot(tree.rootNode)).toEqual(initialSnapshot);
              } finally {
                tree?.delete();
                reference.delete();
              }
            }
          }
        }
      }
    } finally {
      parser.delete();
    }
  });

  test.each(['unknown', 'never'])('preserves parenthesized arrow return annotations and edits for %s', (name) => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const parameters of ['()', '(a)']) {
        for (const trivia of ['', ' /* c */ ', '\n']) {
          for (const body of ['{}', 'a', 'number=>a']) {
            const source = `const f=${parameters}:${trivia}(${trivia}${name}${trivia})${trivia}=>${trivia}${body};`;
            checkArrowEdits(parser, source, name, queries, (tree) => {
              expect(tree.rootNode.hasError, source).toBe(false);
              const value = tree.rootNode.namedChildren[0]!.namedChildren[0]!.childForFieldName('value')!;
              expect(value?.type, source).toBe('arrow_function');
              expect(value.childForFieldName('return_type')!.namedChildren.find((node) => !node.isExtra)!.type).toBe(
                'parenthesized_type'
              );
              expect(value.childForFieldName('body'), source).not.toBeNull();
            });
          }
        }
      }
    } finally {
      parser.delete();
    }
  });

  test.each(['unknown', 'never', 'unique'])(
    'retains function-type arrow return annotations and edits for %s',
    (name) => {
      const parser = new Parser().setLanguage(language);
      const bindings = new Query(language, '(required_parameter pattern: (pattern/identifier) @name)');
      try {
        for (const parameters of ['()', '(a)', '<T>(a:T)']) {
          for (const trivia of ['', ' /* c */ ', '\n']) {
            for (const body of [
              'void=>1',
              'void=>{}',
              'extends=>1',
              'extends=>{}',
              ...(name === 'unique' ? ['number=>a'] : []),
            ]) {
              const source = `const f=${parameters}:${trivia}(${trivia}${name}${trivia})${trivia}=>${trivia}${body};`;
              checkArrowEdits(parser, source, name, queries, (tree) => {
                expect(tree.rootNode.hasError, source).toBe(false);
                const value = tree.rootNode.namedChildren[0]!.namedChildren[0]!.childForFieldName('value')!;
                expect(value?.type, source).toBe('arrow_function');
                expect(value.childForFieldName('return_type')!.namedChildren.find((node) => !node.isExtra)!.type).toBe(
                  'function_type'
                );
                expect(value.childForFieldName('body')!.text, source).toBe(body.slice(body.indexOf('=>') + 2));
                const start = source.indexOf(name);
                expect(
                  bindings
                    .captures(tree.rootNode)
                    .filter(({ node }) => node.text === name)
                    .map(({ node }) => [node.text, node.startIndex, node.endIndex])
                ).toEqual([[name, start, start + name.length]]);
              });
            }
          }
        }
      } finally {
        bindings.delete();
        parser.delete();
      }
    }
  );

  test('keeps malformed unique return annotations consistent through repair edits', () => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const parameters of ['()', '(a)', '<T>(a:T)']) {
        for (const trivia of ['', ' /* c */ ', '\n']) {
          for (const body of ['{}', 'a', 'void 0']) {
            const source = `const f=${parameters}:${trivia}(${trivia}unique${trivia})${trivia}=>${trivia}${body};`;
            checkArrowEdits(parser, source, 'unique', queries, (tree) => {
              expect(tree.rootNode.hasError, source).toBe(true);
            });
            const repaired = parser.parse(source.replace('unique', 'number'))!;
            try {
              expect(repaired.rootNode.hasError, source).toBe(false);
              const value = repaired.rootNode.namedChildren[0]!.namedChildren[0]!.childForFieldName('value')!;
              expect(value?.type, source).toBe('arrow_function');
              expect(value.childForFieldName('body'), source).not.toBeNull();
            } finally {
              repaired.delete();
            }
          }
        }
      }
    } finally {
      parser.delete();
    }
  });

  test.each(['unknown', 'never', 'unique'])('retains incomplete arrow body edits for %s', (name) => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const parameters of ['()', '(a)', '<T>(a:T)']) {
        for (const trivia of ['', ' /* c */ ', '\n']) {
          const source = `const f=${parameters}:${trivia}(${trivia}${name}${trivia})${trivia}=>${trivia};`;
          checkArrowEdits(parser, source, name, queries, (tree) => {
            expect(tree.rootNode.hasError, source).toBe(true);
          });
        }
      }
    } finally {
      parser.delete();
    }
  });

  test.each(['unknown', 'never', 'unique'])('keeps union and rest repairs consistent for %s', (name) => {
    const parser = new Parser().setLanguage(language);
    const bindings = new Query(language, '(required_parameter pattern: (pattern/identifier) @name)');
    try {
      for (const [source, removed] of [
        [`type F=(${name})=>T | U;`, 'U'],
        [`type F=(${name})=>T & U;`, 'U'],
        [`type F=(${name}, ...rest)=>number;`, 'rest'],
      ] as const) {
        let currentSource: string = source;
        let tree: Tree | undefined = parser.parse(currentSource)!;
        const start = currentSource.indexOf(removed);
        try {
          expect(tree.rootNode.hasError, currentSource).toBe(false);
          for (const [before, after] of [
            [removed, ''],
            ['', removed],
          ] as const) {
            const next = currentSource.slice(0, start) + after + currentSource.slice(start + before.length);
            const previousTree = tree;
            tree = undefined;
            try {
              tree = compareEditedTree(
                parser,
                previousTree,
                next,
                new Edit({
                  startIndex: start,
                  oldEndIndex: start + before.length,
                  newEndIndex: start + after.length,
                  startPosition: position(currentSource, start),
                  oldEndPosition: position(currentSource, start + before.length),
                  newEndPosition: position(next, start + after.length),
                }),
                (incremental, fresh) => {
                  expect(incremental.rootNode.hasError, next).toBe(after === '');
                  expect(
                    bindings
                      .captures(incremental.rootNode)
                      .filter(({ node }) => node.text === name)
                      .map(({ node }) => node.text)
                  ).toEqual(after === '' ? [] : [name]);
                  for (const query of queries) {
                    expect(
                      query.captures(incremental.rootNode).map(({ name, node }) => [name, snapshot(node)])
                    ).toEqual(query.captures(fresh.rootNode).map(({ name, node }) => [name, snapshot(node)]));
                  }
                },
                true
              );
            } finally {
              previousTree.delete();
            }
            currentSource = next;
          }
        } finally {
          tree?.delete();
        }
      }
    } finally {
      bindings.delete();
      parser.delete();
    }
  });

  test.each(['unknown', 'never', 'unique'])('retains canonical bindings and edits for %s', (name) => {
    const parser = new Parser().setLanguage(language);
    const bindings = new Query(
      language,
      '[(required_parameter pattern: (pattern/identifier) @name) (optional_parameter pattern: (pattern/identifier) @name)]'
    );
    try {
      for (const generic of ['', '<T>']) {
        for (const optional of ['', '?']) {
          for (const trivia of ['', ' /* binding */ ', '\n']) {
            for (const header of [
              'BINDING',
              'BINDING, other:T',
              'other:T, BINDING',
              'BINDING, other?:T',
              'BINDING, other?, third?',
              'BINDING, other?,',
            ]) {
              const parameters = header.replace('BINDING', name + trivia + optional);
              const source = `type F=${generic}(${parameters})=>unknown;`;
              const start = source.indexOf(name),
                end = start + name.length;
              const ordinary = source.slice(0, start) + 'x'.repeat(name.length) + source.slice(end);
              const reference = parser.parse(ordinary)!;
              let tree: Tree | undefined;
              try {
                expect(reference.rootNode.hasError).toBe(false);
                tree = parser.parse(source)!;
                expect(tree.rootNode.hasError).toBe(false);
                expect(snapshot(tree.rootNode)).toEqual(snapshot(reference.rootNode));
                for (const query of queries) {
                  expect(query.captures(tree.rootNode).map(({ name, node }) => [name, snapshot(node)])).toEqual(
                    query.captures(reference.rootNode).map(({ name, node }) => [name, snapshot(node)])
                  );
                }
                expect(
                  bindings
                    .captures(tree.rootNode)
                    .filter(({ node }) => node.text === name)
                    .map(({ node }) => [node.startIndex, node.endIndex])
                ).toEqual([[start, end]]);
                let previousSource = source;
                let previousName = name;
                for (const replacement of ['argument', name]) {
                  const next =
                    previousSource.slice(0, start) + replacement + previousSource.slice(start + previousName.length);
                  const previousTree = tree;
                  tree = undefined;
                  try {
                    tree = compareEditedTree(
                      parser,
                      previousTree,
                      next,
                      new Edit({
                        startIndex: start,
                        oldEndIndex: start + previousName.length,
                        newEndIndex: start + replacement.length,
                        startPosition: position(previousSource, start),
                        oldEndPosition: position(previousSource, start + previousName.length),
                        newEndPosition: position(next, start + replacement.length),
                      }),
                      (incremental, fresh) => {
                        for (const query of queries) {
                          expect(
                            query.captures(incremental.rootNode).map(({ name, node }) => [name, snapshot(node)])
                          ).toEqual(query.captures(fresh.rootNode).map(({ name, node }) => [name, snapshot(node)]));
                        }
                        expect(
                          bindings
                            .captures(incremental.rootNode)
                            .filter(({ node }) => node.text === replacement)
                            .map(({ node }) => [node.startIndex, node.endIndex])
                        ).toEqual([[start, start + replacement.length]]);
                      }
                    );
                  } finally {
                    previousTree.delete();
                  }
                  previousSource = next;
                  previousName = replacement;
                }
              } finally {
                tree?.delete();
                reference.delete();
              }
            }
          }
        }
      }
    } finally {
      bindings.delete();
      parser.delete();
    }
  });
});

function checkArrowEdits(
  parser: Parser,
  source: string,
  name: string,
  queries: Query[],
  check: (tree: Tree) => void
): void {
  let tree: Tree | undefined = parser.parse(source)!;
  try {
    check(tree);
    const initialSnapshot = snapshot(tree.rootNode);
    const arrowStart = source.indexOf('=>');
    for (const [before, after] of [
      [name, 'number'],
      ['number', name],
      ['=>', ''],
      ['', '=>'],
    ] as const) {
      const start = before === '' ? arrowStart : source.indexOf(before);
      const next = source.slice(0, start) + after + source.slice(start + before.length);
      const previousTree = tree;
      tree = undefined;
      try {
        tree = compareEditedTree(
          parser,
          previousTree,
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
            for (const query of queries) {
              expect(query.captures(incremental.rootNode).map(({ name, node }) => [name, snapshot(node)])).toEqual(
                query.captures(fresh.rootNode).map(({ name, node }) => [name, snapshot(node)])
              );
            }
          },
          true
        );
      } finally {
        previousTree.delete();
      }
      source = next;
    }
    expect(snapshot(tree.rootNode)).toEqual(initialSnapshot);
    check(tree);
  } finally {
    tree?.delete();
  }
}

function snapshot(node: Node): unknown {
  return [
    node.type,
    node.grammarType,
    node.isNamed,
    node.isMissing,
    node.isExtra,
    node.hasError,
    node.startIndex,
    node.endIndex,
    node.startPosition,
    node.endPosition,
    node.children.map((_, index) => node.fieldNameForChild(index)),
    node.children.map(snapshot),
  ];
}
