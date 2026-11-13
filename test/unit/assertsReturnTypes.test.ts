import { type Node, Parser, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { firstNonExtraNamedChild, walkNodes } from '../helpers/nodeRoles.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

const Prefix = `type asserts<T = unknown> = T;
namespace asserts { export interface X {} }
let qualified: asserts.X;
type PlainQuery = typeof asserts;
type ConditionalQuery = T1 extends (typeof asserts) ? X : Y;
type ObjectQuery = T1 extends { value: typeof asserts } ? X : Y;
type UnparenthesizedQuery = T1 extends typeof asserts ? X : Y;
const conditionalQuery = consume<T1 extends (typeof asserts) ? X : Y>();
const computedObject = { [asserts]: true, [asserts.x]: false };
class ComputedField { [asserts]: number }
class ComputedMethod { [asserts]() {} }
interface ComputedInterface { [asserts]: 1; [asserts.x]: 2 }
type Indexed = { [asserts: string]: 1 };
class IndexedClass { [asserts: string]: number }
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
const castIsPrefix = ((value: unknown) => {}) as (is1: unknown) => asserts is1;
const castShortPrefix = ((value: unknown) => {}) as (i: unknown) => asserts i;
const castEscapedPrefix = ((value: unknown) => {}) as (\\u0069s1: unknown) => asserts \\u0069s1;
const castAssertsPredicate = ((value: unknown) => {}) as (is1: unknown) => asserts is1 is string;
const castShortAssertsPredicate = ((value: unknown) => {}) as (i: unknown) => asserts i is string;
const castTypePredicate = ((value: unknown) => true) as (is1: unknown) => is1 is string;
const castAssertsSubjectPredicate = ((value: unknown) => true) as (asserts: unknown) => asserts is string;
const castGenericReturn = (() => '' as any) as () => asserts<string>;
declare function editable(value: unknown): `;
const Suffix = `;
const following = 1;
`;

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves ${dialect} asserts type references and predicates`, async () => {
    const prefix =
      (dialect === 'tsx'
        ? 'const view = <asserts.View />; const flat = <asserts />; const paired = <asserts>text</asserts>;\n'
        : '') + Prefix;
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser().setLanguage(language);
    try {
      for (const type of [
        'asserts',
        'asserts<string>',
        'asserts.X',
        'asserts.X<string>',
        'T1 extends (typeof asserts) ? X : Y',
        'T1 extends { value: typeof asserts } ? X : Y',
        'asserts value',
        'asserts value is string',
        'value is asserts',
        '() => asserts',
        'asserts /* same line */ value',
        'asserts\n',
      ]) {
        const source = prefix + type + Suffix;
        const tree = parser.parse(source)!;
        try {
          checkReturns(tree, source, dialect);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });
}

function checkReturns(tree: Tree, source: string, dialect: string): void {
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
  const expectedComputed: (string | number)[][] = [];
  const expectedIndices: (string | number)[][] = [];
  const expectedQueries: (string | number)[][] = [];
  const expectedConditionals: (string | number)[][] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && !ts.isIndexSignatureDeclaration(node) && node.type) {
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
    if (ts.isTypeQueryNode(node)) {
      expectedQueries.push([node.getText(reference), node.getStart(reference), node.end]);
    }
    if (ts.isConditionalTypeNode(node)) {
      expectedConditionals.push([node.getText(reference), node.getStart(reference), node.end]);
    }
    if (ts.isComputedPropertyName(node)) {
      expectedComputed.push([node.getText(reference), node.getStart(reference), node.end]);
    }
    if (ts.isIndexSignatureDeclaration(node)) {
      const name = node.parameters[0]!.name;
      expectedIndices.push([name.getText(reference), name.getStart(reference), name.end]);
    }
    if (ts.isParameter(node) && !ts.isIndexSignatureDeclaration(node.parent)) {
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

  const returnNodes: Node[] = [];
  walkNodes(tree.rootNode, (node) => {
    const returnType =
      node.childForFieldName('return_type') ??
      (node.type === 'construct_signature' || node.type === 'constructor_type'
        ? node.childForFieldName('type')
        : undefined);
    if (returnType) returnNodes.push(returnType);
  });
  const actual = returnNodes.map((node) => {
    const returned = node.type.endsWith('_annotation') ? firstNonExtraNamedChild(node)! : node;
    return [returned.text, returned.startIndex, returned.endIndex, returned.type === 'asserts'];
  });
  expect(actual).toEqual(expected);
  const tupleLabels = tree.rootNode.descendantsOfType('tuple_type').flatMap((tuple) =>
    tuple.namedChildren.flatMap((param) => {
      const label =
        param.type === 'required_parameter' || param.type === 'optional_parameter'
          ? param.childForFieldName('name')
          : undefined;
      return label ? [parameterRange(label)] : [];
    })
  );
  expect(tupleLabels).toEqual(expectedLabels);
  const bindings = tree.rootNode.descendantsOfType(['required_parameter', 'optional_parameter']).flatMap((param) => {
    const pattern = param.childForFieldName('pattern');
    return pattern ? [parameterRange(pattern)] : [];
  });
  expect(bindings).toEqual(expectedBindings);
  expect(nodeRanges(tree.rootNode, 'type_parameters')).toEqual(expectedParameters);
  expect(nodeRanges(tree.rootNode, 'computed_property_name')).toEqual(expectedComputed);
  expect(
    tree.rootNode.descendantsOfType('index_signature').flatMap((node) => {
      const name = node.childForFieldName('name');
      return name ? [[name.text, name.startIndex, name.endIndex]] : [];
    })
  ).toEqual(expectedIndices);
  expect(nodeRanges(tree.rootNode, 'type_query')).toEqual(expectedQueries);
  expect(nodeRanges(tree.rootNode, 'conditional_type')).toEqual(expectedConditionals);
  expect(tree.rootNode.lastNamedChild!.text).toBe('const following = 1;');
}

function nodeRanges(root: Node, type: string): [string, number, number][] {
  return root.descendantsOfType(type).map((node) => [node.text, node.startIndex, node.endIndex]);
}

function parameterRange(node: Node): (string | number | boolean)[] {
  const name = node.type === 'rest_pattern' ? firstNonExtraNamedChild(node)! : node;
  return [
    name.text,
    name.startIndex,
    name.endIndex,
    node.parent!.type === 'optional_parameter',
    node.type === 'rest_pattern',
  ];
}
