import fs from 'node:fs';

import { Edit, Parser, Query, type Node, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import treeSitterJson from '../../tree-sitter.json';

import { compareEditedTree, position } from '../helpers/treeEdit.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

const Prefix = `type asserts<T = unknown> = T;
namespace asserts { export interface X {} }
let qualified: asserts.X;
type RequiredLabel = [asserts: string];
type OptionalLabel = [asserts?: string];
type RestLabel = [...asserts: string[]];
type Untyped = (asserts) => void;
type OptionalUntyped = (asserts?) => void;
type RestUntyped = (...asserts) => void;
const genericArrow = <asserts,>(value: asserts) => value;
interface ExtendsBare extends asserts {}
interface ExtendsQualified extends asserts.X {}
interface ExtendsGeneric extends asserts<string> {}
declare function qualifiedReturn(): asserts.X;
declare function standalone(value: unknown): asserts;
interface I {
  method(value: unknown): asserts;
  callback: () => asserts;
  <T>(): asserts;
  new(): asserts;
}
declare class C { method(value: unknown): asserts; }
type Callback = () => asserts;
type Factory = new () => asserts;
const arrow = (value: unknown): asserts => value;
const object = { method(value: unknown): asserts { return value; } };
function ordinary(value: unknown): asserts { return value; }
declare function assertion(value: unknown): asserts value;
declare function predicate(value: unknown): asserts value is string;
declare function generic(value: unknown): asserts<string>;
declare function editable(value: unknown): `;
const Suffix = `;
const following = 1;
`;
const InitialType = 'asserts';

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves asserts type references and predicates through ${dialect} edits`, async () => {
    const prefix =
      (dialect === 'tsx'
        ? 'const view = <asserts.View />; const flat = <asserts />; const paired = <asserts>text</asserts>;\n'
        : '') + Prefix;
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser().setLanguage(language);
    const query = new Query(
      language,
      '(_ return_type: (_) @return) (construct_signature type: (_) @return) (constructor_type type: (_) @return) (type_parameters) @parameters (tuple_type (required_parameter name: (_) @tupleLabel)) (tuple_type (optional_parameter name: (_) @tupleLabel)) (required_parameter pattern: (_) @binding) (optional_parameter pattern: (_) @binding)'
    );
    const grammar = treeSitterJson.grammars.find((entry) => entry.name === dialect)!;
    const queries = (['highlights', 'tags', 'locals', 'injections'] as const).map(
      (kind) =>
        new Query(
          language,
          [grammar[kind]]
            .flat()
            .map((file) => fs.readFileSync(file, 'utf8'))
            .join('\n')
        )
    );
    const captures = (tree: Tree): unknown =>
      queries.map((compiled) =>
        compiled
          .captures(tree.rootNode)
          .map(({ name, node }) => [name, node.type, node.text, node.startIndex, node.endIndex])
      );
    let annotation = InitialType;
    let source = prefix + annotation + Suffix;
    let tree = parser.parse(source)!;
    try {
      checkReturns(tree, source, dialect, query);
      for (const nextType of [
        'asserts<string>',
        'asserts.X',
        'asserts.X<string>',
        'asserts value',
        'asserts value is string',
        'value is asserts',
        '() => asserts',
        'asserts /* same line */ value',
        'asserts\n',
        InitialType,
      ]) {
        const next = prefix + nextType + Suffix;
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex: prefix.length,
            oldEndIndex: prefix.length + annotation.length,
            newEndIndex: prefix.length + nextType.length,
            startPosition: position(source, prefix.length),
            oldEndPosition: position(source, prefix.length + annotation.length),
            newEndPosition: position(next, prefix.length + nextType.length),
          }),
          (incremental, fresh) => {
            checkReturns(incremental, next, dialect, query);
            checkReturns(fresh, next, dialect, query);
            expect(captures(incremental)).toEqual(captures(fresh));
          }
        );
        previous.delete();
        annotation = nextType;
        source = next;
      }
    } finally {
      tree.delete();
      query.delete();
      for (const compiled of queries) compiled.delete();
      parser.delete();
    }
  });
}

function checkReturns(tree: Tree, source: string, dialect: string, query: Query): void {
  const reference = ts.createSourceFile(
    `fixture.${dialect === 'tsx' ? 'tsx' : 'ts'}`,
    source,
    ts.ScriptTarget.Latest,
    true
  );
  expect(
    ts.transpileModule(source, {
      reportDiagnostics: true,
      fileName: dialect === 'tsx' ? 'fixture.tsx' : 'fixture.ts',
      compilerOptions: { target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.Preserve },
    }).diagnostics ?? [],
    source
  ).toEqual([]);
  expect(tree.rootNode.hasError, source).toBe(false);
  const expected: (string | number | boolean)[][] = [];
  const expectedParameters: (string | number)[][] = [];
  const expectedLabels: (string | number | boolean)[][] = [];
  const expectedBindings: (string | number | boolean)[][] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node.type) {
      expected.push([
        node.type.getText(reference),
        node.type.getStart(reference),
        node.type.end,
        ts.isTypePredicateNode(node.type) && !!node.type.assertsModifier,
      ]);
    }
    if (
      (ts.isFunctionLike(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      node.typeParameters?.length
    ) {
      const start = node.typeParameters.pos - 1;
      const end = node.getChildren(reference).find((child) => child.kind === ts.SyntaxKind.GreaterThanToken)!.end;
      expectedParameters.push([source.slice(start, end), start, end]);
    }
    if (ts.isNamedTupleMember(node)) {
      expectedLabels.push([
        node.name.getText(reference),
        node.name.getStart(reference),
        node.name.end,
        !!node.questionToken,
        !!node.dotDotDotToken,
      ]);
    }
    if (ts.isParameter(node)) {
      expectedBindings.push([
        node.name.getText(reference),
        node.name.getStart(reference),
        node.name.end,
        !!node.questionToken,
        !!node.dotDotDotToken,
      ]);
    }
    ts.forEachChild(node, visit);
  };
  visit(reference);

  const captures = query.captures(tree.rootNode);
  const actual = captures
    .filter(({ name }) => name === 'return')
    .map(({ node }) => {
      const returned = node.type.endsWith('_annotation') ? node.namedChildren[0]! : node;
      return [returned.text, returned.startIndex, returned.endIndex, returned.type === 'asserts'];
    });
  expect(actual).toEqual(expected);
  expect(captures.filter(({ name }) => name === 'tupleLabel').map(({ node }) => parameterRange(node))).toEqual(
    expectedLabels
  );
  expect(captures.filter(({ name }) => name === 'binding').map(({ node }) => parameterRange(node))).toEqual(
    expectedBindings
  );
  expect(
    captures.filter(({ name }) => name === 'parameters').map(({ node }) => [node.text, node.startIndex, node.endIndex])
  ).toEqual(expectedParameters);
  expect(tree.rootNode.lastNamedChild!.text).toBe('const following = 1;');
}

function parameterRange(node: Node): (string | number | boolean)[] {
  const name = node.type === 'rest_pattern' ? node.namedChildren[0]! : node;
  return [
    name.text,
    name.startIndex,
    name.endIndex,
    node.parent!.type === 'optional_parameter',
    node.type === 'rest_pattern',
  ];
}
