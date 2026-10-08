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
      for (const continuation of ['=>', 'number']) {
        let source = `type F=(${name})=>number;`;
        let tree: Tree | undefined = parser.parse(source)!;
        const start = source.indexOf(continuation);
        let previous = continuation;
        try {
          for (const replacement of ['', continuation]) {
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
                  expect(incremental.rootNode.hasError).toBe(replacement === '');
                  expect(bindings.captures(incremental.rootNode).map(({ node }) => node.text)).toEqual(
                    replacement === '' ? [] : [name]
                  );
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
            for (const header of ['BINDING', 'BINDING, other:T', 'other:T, BINDING', 'BINDING, other?:T']) {
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
