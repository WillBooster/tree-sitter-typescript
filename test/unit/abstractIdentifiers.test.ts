import { Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

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
    test(`retains ${dialect} abstract ${description}`, async () => {
      await Parser.init();
      const parser = new Parser();
      let query: Query | undefined;
      try {
        const language = await loadCurrentWasmBuild(dialect);
        parser.setLanguage(language);
        query = new Query(
          language,
          '(identifier) @name\n(property_identifier) @name\n(type_identifier) @name\n(call_signature) @signature\n(type_parameter name: (type_identifier) @parameter)'
        );
        const ordinarySource = initialSource.slice(0, offset) + 'ordinary' + initialSource.slice(offset + 8);
        for (const source of [initialSource, ordinarySource]) {
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError).toBe(false);
            expect(captures(query, tree)).toEqual(referenceRanges(source, dialect));
            expectNameKinds(parser, query, tree, source, dialect);
            if (description.includes('generic'))
              expect(parameterCaptures(query, tree)).toEqual(referenceParameters(source, dialect));
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

function expectNameKinds(parser: Parser, query: Query, tree: Tree, source: string, dialect: string): void {
  const ranges = referenceRanges(source, dialect);
  let ordinarySource = source;
  for (const [start, end] of ranges) {
    if (source.slice(start, end) === 'abstract')
      ordinarySource = ordinarySource.slice(0, start) + 'ordinary' + ordinarySource.slice(end);
  }
  const ordinary = parser.parse(ordinarySource)!;
  try {
    expect(ordinary.rootNode.hasError).toBe(false);
    expect(kinds(tree)).toEqual(kinds(ordinary));
  } finally {
    ordinary.delete();
  }

  function kinds(current: Tree): readonly (readonly [string, number, number])[] {
    return query
      .captures(current.rootNode)
      .filter(
        ({ name, node }) =>
          name !== 'parameter' && ranges.some(([start, end]) => node.startIndex === start && node.endIndex === end)
      )
      .map(({ node }) => [node.type, node.startIndex, node.endIndex] as const)
      .toSorted((a, b) => a[1] - b[1]);
  }
}

function referenceRanges(source: string, dialect: string): Capture[] {
  expect(
    ts.transpileModule(source, {
      fileName: dialect === 'tsx' ? 'abstract.tsx' : 'abstract.ts',
      reportDiagnostics: true,
      compilerOptions: { jsx: ts.JsxEmit.Preserve },
    }).diagnostics
  ).toHaveLength(0);
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
  test(`rejects ${dialect} keyword heritage names`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser().setLanguage(language);
    const query = new Query(language, '(extends_type_clause type: (type_identifier) @heritage)');
    try {
      for (const name of ['abstract', 'in']) {
        const source = `interface Named extends ${name} {}`;
        const start = source.indexOf(name);
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError).toBe(name === 'in');
          expect(query.captures(tree.rootNode).map(({ node }) => [node.text, node.startIndex, node.endIndex])).toEqual(
            name === 'abstract' ? [['abstract', start, start + name.length]] : []
          );
        } finally {
          tree.delete();
        }
      }
    } finally {
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
