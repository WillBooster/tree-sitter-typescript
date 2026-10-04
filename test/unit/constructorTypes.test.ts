import { Edit, Parser, Query, type Node, type Point, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { loadCurrentWasmBuild } from './wasmBuild.js';

type ReturnCapture = readonly [number, string, number, number];

const Source = `type B = { b: number };
type C = { c: number };
type UnionFactory = new () => B | C;
type IntersectionFactory = new () => B & C;
type ConditionalFactory<T> = abstract new (value: T) => T extends B ? B : C;
type NestedFactory = new () => new () => B | C;
type UnionOfFactories = (new () => B) | (new () => C);
interface Registry { make: UnionFactory; merge: IntersectionFactory; conditional: ConditionalFactory<B>; nested: NestedFactory; separate: UnionOfFactories; }
`;

for (const dialect of ['typescript', 'tsx']) {
  test(`retains ${dialect} constructor return grouping through operator edits`, async () => {
    await Parser.init();
    const parser = new Parser();
    let query: Query | undefined;
    let tree: Tree | undefined;
    let source = Source;
    try {
      const language = await loadCurrentWasmBuild(dialect);
      parser.setLanguage(language);
      query = new Query(language, '(constructor_type type: (_) @result) @factory');
      tree = parser.parse(source)!;
      expect(tree.rootNode.hasError).toBe(false);
      expect(returnCaptures(query, tree)).toEqual(referenceReturns(source, dialect));
      const offset = source.indexOf('|');
      for (const operator of ['&', '|']) {
        const next = source.slice(0, offset) + operator + source.slice(offset + 1);
        tree.edit(
          new Edit({
            startIndex: offset,
            oldEndIndex: offset + 1,
            newEndIndex: offset + 1,
            startPosition: position(source, offset),
            oldEndPosition: position(source, offset + 1),
            newEndPosition: position(next, offset + 1),
          })
        );
        const previous: Tree = tree;
        tree = parser.parse(next, previous)!;
        previous.delete();
        const fresh = parser.parse(next)!;
        try {
          expect(tree.rootNode.hasError).toBe(false);
          expect(snapshot(tree.rootNode)).toEqual(snapshot(fresh.rootNode));
          const expected = referenceReturns(next, dialect);
          expect(returnCaptures(query, tree)).toEqual(expected);
          expect(returnCaptures(query, fresh)).toEqual(expected);
        } finally {
          fresh.delete();
        }
        source = next;
      }
    } finally {
      tree?.delete();
      query?.delete();
      parser.delete();
    }
  });
}

function position(source: string, index: number): Point {
  const lines = source.slice(0, index).split('\n');
  return { row: lines.length - 1, column: lines.at(-1)!.length };
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

function snapshot(node: Node): unknown {
  return [
    node.type,
    node.isNamed,
    node.isMissing,
    node.startIndex,
    node.endIndex,
    node.startPosition,
    node.endPosition,
    node.children.map((_, i) => node.fieldNameForChild(i)),
    node.children.map(snapshot),
  ];
}
