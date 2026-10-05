import { Edit, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { compareEditedTree, position } from '../helpers/treeEdit.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

type ReturnCapture = readonly [number, string, number, number];

const Source = `type B = { b: number };
type C = { c: number };
type UnionFactory = new () => B | C;
type IntersectionFactory = new () => B & C;
type ConditionalFactory<T> = abstract new (value: T) => T extends B ? B : C;
type MultilineFactory = abstract
new () => B | C;
type CommentFactory = abstract/*
continuation*/new () => B & C;
type NestedFactory = new () => new () => B | C;
type UnionOfFactories = (new () => B) | (new () => C);
interface Registry { make: UnionFactory; merge: IntersectionFactory; conditional: ConditionalFactory<B>; nested: NestedFactory; separate: UnionOfFactories; }
`;

const ContinuationSource = `type abstract = number;
function newFoo() {}
const ne = 1;
type F = abstract
new () => string;
type G = abstract;
new Date();
type H = abstract
newFoo();
type I = abstract
ne;
`;

const RecoverySource = `${ContinuationSource}type J = abstract
/*c*/new () => number;
`;

const RecoveryEdits = [
  [36, 0, '&'],
  [210, 1, ''],
  [200, 0, '}'],
  [148, 0, '['],
  [36, 0, ':'],
  [116, 0, ']'],
  [85, 1, ''],
  [12, 1, ''],
] as const;

for (const dialect of ['typescript', 'tsx']) {
  for (const [description, initialSource, offset, original, replacements] of [
    ['return grouping', Source, Source.indexOf('|'), '|', ['&', '|']],
    [
      'abstract continuation',
      ContinuationSource,
      ContinuationSource.indexOf('abstract\n') + 8,
      '\n',
      ['/*\ncomment*/', '\n'],
    ],
  ] as const) {
    test(`retains ${dialect} constructor ${description} through edits`, async () => {
      await Parser.init();
      const parser = new Parser();
      let query: Query | undefined;
      let tree: Tree | undefined;
      let source: string = initialSource;
      try {
        const language = await loadCurrentWasmBuild(dialect);
        parser.setLanguage(language);
        query = new Query(language, '(constructor_type type: (_) @result) @factory');
        tree = parser.parse(source)!;
        expect(tree.rootNode.hasError).toBe(false);
        expect(returnCaptures(query, tree)).toEqual(referenceReturns(source, dialect));
        let oldLength = original.length;
        for (const replacement of replacements) {
          const next = source.slice(0, offset) + replacement + source.slice(offset + oldLength);
          const previous: Tree = tree;
          tree = compareEditedTree(
            parser,
            previous,
            next,
            new Edit({
              startIndex: offset,
              oldEndIndex: offset + oldLength,
              newEndIndex: offset + replacement.length,
              startPosition: position(source, offset),
              oldEndPosition: position(source, offset + oldLength),
              newEndPosition: position(next, offset + replacement.length),
            }),
            (incremental, fresh) => {
              const expected = referenceReturns(next, dialect);
              expect(returnCaptures(query!, incremental)).toEqual(expected);
              expect(returnCaptures(query!, fresh)).toEqual(expected);
            }
          );
          previous.delete();
          source = next;
          oldLength = replacement.length;
        }
      } finally {
        tree?.delete();
        query?.delete();
        parser.delete();
      }
    });
  }
}

for (const dialect of ['typescript', 'tsx']) {
  test(`retains ${dialect} constructor boundaries through recovery edits`, async () => {
    await Parser.init();
    const parser = new Parser();
    let query: Query | undefined;
    let tree: Tree | undefined;
    let source = RecoverySource;
    const undo: [number, number, string][] = [];
    try {
      parser.setLanguage(await loadCurrentWasmBuild(dialect));
      query = new Query(parser.language!, '(constructor_type type: (_) @result) @factory');
      tree = parser.parse(source)!;
      expect(tree.rootNode.hasError).toBe(false);
      expect(returnCaptures(query, tree)).toEqual(referenceReturns(source, dialect));
      for (const [start, length, text] of RecoveryEdits) {
        undo.unshift([start, text.length, source.slice(start, start + length)]);
        edit(start, length, text);
      }
      for (const [start, length, text] of undo) edit(start, length, text);
      expect(source).toBe(RecoverySource);
      expect(tree.rootNode.hasError).toBe(false);
    } finally {
      tree?.delete();
      query?.delete();
      parser.delete();
    }

    function edit(start: number, length: number, text: string): void {
      const next = source.slice(0, start) + text + source.slice(start + length);
      const previous = tree!;
      tree = compareEditedTree(
        parser,
        previous,
        next,
        new Edit({
          startIndex: start,
          oldEndIndex: start + length,
          newEndIndex: start + text.length,
          startPosition: position(source, start),
          oldEndPosition: position(source, start + length),
          newEndPosition: position(next, start + text.length),
        }),
        (incremental, fresh) => {
          expect(returnCaptures(query!, incremental)).toEqual(returnCaptures(query!, fresh));
        },
        true
      );
      previous.delete();
      source = next;
    }
  });
}

function referenceReturns(source: string, dialect: string): ReturnCapture[] {
  const reference = ts.createSourceFile(
    `constructors.${dialect === 'tsx' ? 'tsx' : 'ts'}`,
    source,
    ts.ScriptTarget.Latest,
    true,
    dialect === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const expected: ReturnCapture[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isConstructorTypeNode(node))
      expected.push([
        node.getStart(reference),
        node.type.getText(reference),
        node.type.getStart(reference),
        node.type.getEnd(),
      ]);
    ts.forEachChild(node, visit);
  };
  visit(reference);
  return expected.toSorted((a, b) => a[0] - b[0]);
}

function returnCaptures(query: Query, tree: Tree): ReturnCapture[] {
  return query
    .matches(tree.rootNode)
    .map(({ captures }) => {
      const factory = captures.find(({ name }) => name === 'factory')!.node;
      const result = captures.find(({ name }) => name === 'result')!.node;
      return [factory.startIndex, result.text, result.startIndex, result.endIndex] as const;
    })
    .toSorted((a, b) => a[0] - b[0]);
}
