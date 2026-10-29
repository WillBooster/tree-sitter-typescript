import { Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

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

const RecoverySource = `type abstract = number;
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
type J = abstract
/*c*/new () => number;
`;

for (const dialect of ['typescript', 'tsx']) {
  for (const [description, sources] of [
    ['return grouping', [Source, Source.replace('|', '&')]],
    ['abstract continuation', [ContinuationSource, ContinuationSource.replace('abstract\n', 'abstract/*\ncomment*/')]],
    ['constructor boundaries', [RecoverySource]],
    ['abstract alias statements', ['type G = abstract; new Date();']],
  ] as const) {
    test(`retains ${dialect} constructor ${description}`, async () => {
      await Parser.init();
      const parser = new Parser();
      let query: Query | undefined;
      try {
        const language = await loadCurrentWasmBuild(dialect);
        parser.setLanguage(language);
        query = new Query(language, '(constructor_type type: (_) @result) @factory');
        for (const source of sources) {
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError).toBe(false);
            expect(returnCaptures(query, tree)).toEqual(referenceReturns(source, dialect));
          } finally {
            tree.delete();
          }
        }
      } finally {
        query?.delete();
        parser.delete();
      }
    });
  }
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
