import { Edit, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { compareEditedTree, position } from '../helpers/treeEdit.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

type Capture = readonly [number, number];

const Source = `const abstract = 3;
type abstract = number;
class Holder { abstract: abstract = abstract; }
class Reader { abstract() { return abstract; } }
abstract;
new Holder().abstract;
new Reader().abstract();
abstract class Base { abstract value: number; abstract read(): number; }
class Derived extends Base { value = abstract; read() { return abstract; } }
`;

const QualifiedSource = `interface abstract {}
interface Named extends abstract {}
namespace abstract { export interface Item {} export type Generic<T> = T; export namespace inner { export interface Item {} } }
let value: abstract.Item;
let generic: abstract.Generic<string>;
interface Qualified extends abstract.Item {}
class Implements implements abstract.Item {}
namespace outer { export namespace abstract { export interface Item {} } }
let nested: outer.abstract.Item;
let deep: abstract.inner.Item;
interface Deep extends abstract.inner.Item {}
`;

const MappedSource = `type Input = { key: string };
type Mapped = { [abstract in keyof Input]: Input[abstract] };
type Remapped = { [abstract in keyof Input as abstract]: Input[abstract] };
type Readonly = { readonly [abstract in keyof Input]: Input[abstract] };
type Optional = { [abstract in keyof Input]?: Input[abstract] };
`;

for (const dialect of ['typescript', 'tsx']) {
  for (const [description, initialSource, offset] of [
    ['contextual names', Source, Source.indexOf('abstract: abstract')],
    ['heritage and qualified type names', QualifiedSource, QualifiedSource.indexOf('abstract.Item')],
    ['mapped type parameters', MappedSource, MappedSource.indexOf('abstract')],
  ] as const) {
    test(`retains ${dialect} abstract ${description} through edits`, async () => {
      await Parser.init();
      const parser = new Parser();
      let query: Query | undefined;
      let tree: Tree | undefined;
      let source: string = initialSource;
      try {
        const language = await loadCurrentWasmBuild(dialect);
        parser.setLanguage(language);
        query = new Query(language, '(identifier) @name\n(property_identifier) @name\n(type_identifier) @name');
        tree = parser.parse(source)!;
        expect(tree.rootNode.hasError).toBe(false);
        expect(captures(query, tree)).toEqual(referenceNames(source, dialect));
        for (const name of ['ordinary', 'abstract']) {
          const next = source.slice(0, offset) + name + source.slice(offset + 8);
          const previous: Tree = tree;
          tree = compareEditedTree(
            parser,
            previous,
            next,
            new Edit({
              startIndex: offset,
              oldEndIndex: offset + 8,
              newEndIndex: offset + name.length,
              startPosition: position(source, offset),
              oldEndPosition: position(source, offset + 8),
              newEndPosition: position(next, offset + name.length),
            }),
            (incremental, fresh) => {
              const expected = referenceNames(next, dialect);
              expect(captures(query!, incremental)).toEqual(expected);
              expect(captures(query!, fresh)).toEqual(expected);
            }
          );
          previous.delete();
          source = next;
        }
      } finally {
        tree?.delete();
        query?.delete();
        parser.delete();
      }
    });
  }
}

function referenceNames(source: string, dialect: string): Capture[] {
  const reference = ts.createSourceFile(
    `abstract.${dialect === 'tsx' ? 'tsx' : 'ts'}`,
    source,
    ts.ScriptTarget.Latest,
    true,
    dialect === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const names: Capture[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'abstract') names.push([node.getStart(reference), node.getEnd()]);
    ts.forEachChild(node, visit);
  };
  visit(reference);
  return names.toSorted((a, b) => a[0] - b[0]);
}

function captures(query: Query, tree: Tree): Capture[] {
  return query
    .captures(tree.rootNode)
    .filter(({ node }) => node.text === 'abstract')
    .map(({ node }) => [node.startIndex, node.endIndex] as const)
    .toSorted((a, b) => a[0] - b[0]);
}
