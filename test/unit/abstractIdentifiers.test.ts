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
import BareAlias = abstract;
import QualifiedAlias = abstract.Item;
import NestedAlias = abstract.inner.Item;
`;

const MappedSource = `type Input = { key: string };
type Mapped = { [abstract in keyof Input]: Input[abstract] };
type Remapped = { [abstract in keyof Input as abstract]: Input[abstract] };
type Readonly = { readonly [abstract in keyof Input]: Input[abstract] };
type Optional = { [abstract in keyof Input]?: Input[abstract] };
`;

const MemberSource = `type abstract = number;
interface Callable { value: abstract
  <T>(value: T): T;
  other: abstract
  (value: string): void;
}
type CallableType = { value: abstract
  <T>(value: T): T;
};
`;

const GenericSource = `const identity = <abstract,>(value: abstract) => value;
const defaulted = <abstract = number,>(value: abstract) => value;
const pair = <abstract, T>(value: abstract, other: T) => other;
function choose<abstract>(value: abstract) { return value; }
class Generic<abstract> { value?: abstract; }
interface Box<abstract> { value: abstract; }
type Alias<abstract> = abstract;
`;

const PlainGenericSource = `const identity = <abstract>(value: abstract) => value;
const defaulted = <abstract = number>(value: abstract) => value;
`;

const JsxSource = `const element = <abstract abstract="value" />;
const paired = <abstract>text</abstract>;
const qualified = <abstract.Item />;
const member = <ordinary.abstract />;
const namespace = <abstract:Item />;
const attribute = <ordinary abstract:value="value" />;
`;

for (const dialect of ['typescript', 'tsx']) {
  for (const [description, initialSource, offset] of [
    ['contextual names', Source, Source.indexOf('abstract: abstract')],
    ['heritage and qualified type names', QualifiedSource, QualifiedSource.indexOf('abstract.Item')],
    ['mapped type parameters', MappedSource, MappedSource.indexOf('abstract')],
    ['type member boundaries', MemberSource, MemberSource.indexOf('abstract\n')],
    ['generic parameter names', GenericSource, GenericSource.indexOf('abstract')],
    ...(dialect === 'typescript'
      ? ([['plain generic arrows', PlainGenericSource, PlainGenericSource.indexOf('abstract')]] as const)
      : []),
    ...(dialect === 'tsx' ? ([['JSX names', JsxSource, JsxSource.indexOf('abstract')]] as const) : []),
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
        query = new Query(
          language,
          '(identifier) @name\n(property_identifier) @name\n(type_identifier) @name\n(call_signature) @signature\n(type_parameter name: (type_identifier) @parameter)'
        );
        tree = parser.parse(source)!;
        expect(tree.rootNode.hasError).toBe(false);
        expect(captures(query, tree)).toEqual(referenceRanges(source, dialect));
        if (description.includes('generic'))
          expect(parameterCaptures(query, tree)).toEqual(referenceParameters(source, dialect));
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
              const expected = referenceRanges(next, dialect);
              expect(captures(query!, incremental)).toEqual(expected);
              expect(captures(query!, fresh)).toEqual(expected);
              if (description.includes('generic')) {
                expect(parameterCaptures(query!, incremental)).toEqual(referenceParameters(next, dialect));
                expect(parameterCaptures(query!, fresh)).toEqual(referenceParameters(next, dialect));
              }
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

function referenceRanges(source: string, dialect: string): Capture[] {
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
    if (ts.isCallSignatureDeclaration(node)) {
      const end = node.getEnd();
      names.push([node.getStart(reference), source[end - 1] === ';' ? end - 1 : end]);
    }
    ts.forEachChild(node, visit);
  };
  visit(reference);
  return names.toSorted((a, b) => a[0] - b[0]);
}

for (const dialect of ['typescript', 'tsx']) {
  test(`rejects ${dialect} keyword heritage names through edits`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser().setLanguage(language);
    const query = new Query(language, '(extends_type_clause type: (type_identifier) @heritage)');
    let source = 'interface Named extends abstract {}';
    let tree: Tree | undefined;
    try {
      tree = parser.parse(source)!;
      expect(tree.rootNode.hasError).toBe(false);
      const start = source.indexOf('abstract');
      for (const [before, after] of [
        ['abstract', 'in'],
        ['in', 'abstract'],
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
            for (const current of [incremental, fresh]) {
              expect(current.rootNode.hasError).toBe(after === 'in');
              expect(
                query.captures(current.rootNode).map(({ node }) => [node.text, node.startIndex, node.endIndex])
              ).toEqual(after === 'abstract' ? [['abstract', start, start + after.length]] : []);
            }
          },
          true
        );
        previous.delete();
        source = next;
      }
    } finally {
      tree?.delete();
      query.delete();
      parser.delete();
    }
  });
}

function captures(query: Query, tree: Tree): Capture[] {
  return query
    .captures(tree.rootNode)
    .filter(({ name, node }) => name !== 'parameter' && (node.text === 'abstract' || node.type === 'call_signature'))
    .map(({ node }) => [node.startIndex, node.endIndex] as const)
    .toSorted((a, b) => a[0] - b[0]);
}

function referenceParameters(source: string, dialect: string): Capture[] {
  const reference = ts.createSourceFile(
    'generic.' + dialect,
    source,
    ts.ScriptTarget.Latest,
    true,
    dialect === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  expect(
    ts.transpileModule(source, {
      fileName: dialect === 'tsx' ? 'generic.tsx' : 'generic.ts',
      reportDiagnostics: true,
      compilerOptions: { jsx: ts.JsxEmit.Preserve },
    }).diagnostics
  ).toHaveLength(0);
  const names: Capture[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeParameterDeclaration(node)) names.push([node.name.getStart(reference), node.name.getEnd()]);
    ts.forEachChild(node, visit);
  };
  visit(reference);
  return names;
}

function parameterCaptures(query: Query, tree: Tree): Capture[] {
  return query
    .captures(tree.rootNode)
    .filter(({ name }) => name === 'parameter')
    .map(({ node }) => [node.startIndex, node.endIndex] as const);
}
