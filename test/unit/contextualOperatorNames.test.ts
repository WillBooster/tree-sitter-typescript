import { type Node, Parser, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { firstNonExtraNamedChild, walkNodes } from '../helpers/nodeRoles.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

const Source = `class as { value = 1; read() { return this.value; } }
class satisfies extends as {}
const value = new as;
const result = new satisfies().read();
const named = value as as;
const checked = value satisfies as;
function add(as: number, satisfies: number) { as += satisfies; return as; }
const constructors = { as, satisfies };
const make = () => new satisfies;
const parenthesized = value as (as);
const validated = value satisfies ((as));
type Keys = { first: 1 };
type get = number;
type set = string;
type accessor = boolean;
type type = symbol;
interface ParenthesizedNames {
  get: (get);
  set: ((set));
  accessor: (accessor);
  type: ((type));
}
type Mapped = { [as in keyof Keys as as]: Keys[as] };
type Checked = { [satisfies in keyof Keys as satisfies]: Keys[satisfies] };
class Base<T> {}
class Derived extends Base<as[]> {}
class ValueDerived extends Base<typeof as> {}
interface Inherited extends as {}
const inferred = as as (typeof as);
const checkedClass = satisfies satisfies (typeof satisfies);
const prototype = value as (typeof as.prototype);
type Tuple = [as: string, satisfies?: number, ...as: boolean[]];
type ContextualTuple = [get: string, type?: number, ...accessor: boolean[]];
declare namespace as { namespace Types { class Value { value: number; } } }
declare namespace satisfies { namespace Types { class Value { value: number; } } }
type Qualified = as.Types.Value;
declare namespace get { interface Value {} namespace Inner { interface Value {} interface Generic<T> {} } }
declare namespace type { interface Value {} }
declare namespace Outer { namespace get { interface Value {} } }
import GetNamespace = get;
import GetInner = get.Inner;
type QualifiedGet = get.Value;
type NestedGet = get.Inner.Value;
type MiddleGet = Outer.get.Value;
type GenericGet = get.Inner.Generic<string>;
function qualifiedTypes(value: get.Value): type.Value { return value; }
const qualified = value as as.Types.Value;
const checkedQualified = value satisfies satisfies.Types.Value;
function isString(as: unknown): as is string { return typeof as === 'string'; }
function contextualPredicate(type: unknown): type is string { return typeof type === 'string'; }
const contextualArrow = <T,>(accessor: T): accessor is T => true;
function ensure(satisfies: unknown): asserts satisfies { if (!satisfies) throw Error(); }
function contextualEnsure(type: unknown): asserts type { if (!type) throw Error(); }
const identity = <as,>(item: as) => item;
const contextualIdentity = <get,>(item: get): get => item;
const contextualConstrained = <type extends unknown,>(item: type): type => item;
const defaulted = <satisfies = string,>(item: satisfies) => item;
`;

const JsxSource = `declare namespace JSX { interface Element {} interface ElementClass {} interface IntrinsicElements { [tag: string]: any; } }
const directJsx = <as />;
const checkedJsx = <satisfies />;
const namespacedJsx = <x:as />;
const leftNamespacedJsx = <as:ns />;
const nestedJsx = <as attr={1}><satisfies>text</satisfies><div x={<as />} /></as>;
const memberJsx = <as.Types.Value />;
const attributeJsx = <div as={1} satisfies={2} />;
const contextualJsx = <get />;
const contextualNamespacedJsx = <type:tag />;
const contextualMemberJsx = <get.Inner.Value />;
`;

for (const dialect of ['typescript', 'tsx']) {
  test(`retains ${dialect} contextual constructor names and operator roles across renamed sources`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser().setLanguage(language);
    const source = Source + (dialect === 'tsx' ? JsxSource : '');
    let tree: Tree | undefined;
    try {
      tree = parser.parse(source)!;
      check(tree);
      const renames: [number, string, string][] = [
        ...[
          source.indexOf('new as') + 4,
          source.indexOf('Base<as[]>') + 5,
          source.indexOf('[as in') + 1,
          source.indexOf('typeof as') + 7,
          source.indexOf('[as: string') + 1,
          source.indexOf('type Qualified = as') + 'type Qualified = '.length,
          source.indexOf('const identity = <as') + 'const identity = <'.length,
          ...(dialect === 'tsx'
            ? [
                source.indexOf('const directJsx = <as') + 'const directJsx = <'.length,
                source.indexOf('const namespacedJsx = <x:as') + 'const namespacedJsx = <x:'.length,
                source.indexOf('const leftNamespacedJsx = <as') + 'const leftNamespacedJsx = <'.length,
              ]
            : []),
        ].map((start): [number, string, string] => [start, 'as', 'satisfies']),
        [
          source.indexOf('contextualPredicate(type: unknown): type') + 'contextualPredicate(type: unknown): '.length,
          'type',
          'get',
        ],
        [source.indexOf('contextualIdentity = <get') + 'contextualIdentity = <'.length, 'get', 'set'],
        [source.indexOf('ContextualTuple = [get') + 'ContextualTuple = ['.length, 'get', 'set'],
        [source.indexOf('get: (get)') + 'get: ('.length, 'get', 'set'],
        [source.indexOf('accessor: (accessor)') + 'accessor: ('.length, 'accessor', 'type'],
      ];
      for (const [start, from, to] of renames) {
        const next = source.slice(0, start) + to + source.slice(start + from.length);
        const nextTree = parser.parse(next)!;
        try {
          check(nextTree, next);
        } finally {
          nextTree.delete();
        }
      }
    } finally {
      tree?.delete();
      parser.delete();
    }

    function check(current: Tree, text = source): void {
      const reference = ts.createSourceFile(
        `names.${dialect === 'tsx' ? 'tsx' : 'ts'}`,
        text,
        ts.ScriptTarget.Latest,
        true,
        dialect === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      );
      const constructors: [string, number, number][] = [];
      const assertions: [string, number, number][] = [];
      const types: [string, number, number][] = [];
      const addType = (name: string, node: ts.Node): void => {
        types.push([name, node.getStart(reference), node.getEnd()]);
      };
      const visit = (node: ts.Node): void => {
        if (ts.isNewExpression(node))
          constructors.push([
            node.expression.getText(reference),
            node.expression.getStart(reference),
            node.expression.getEnd(),
          ]);
        if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
          assertions.push([ts.isAsExpression(node) ? 'as' : 'satisfies', node.getStart(reference), node.getEnd()]);
        if (ts.isParenthesizedTypeNode(node)) addType('parenthesized', node);
        if (ts.isTypeQueryNode(node)) addType('query.value', node.exprName);
        if (ts.isNamedTupleMember(node)) addType('tuple.name', node.name);
        if (ts.isJsxOpeningElement(node) || ts.isJsxClosingElement(node) || ts.isJsxSelfClosingElement(node))
          addType('jsx.name', node.tagName);
        if (ts.isTypeReferenceNode(node) && ts.isQualifiedName(node.typeName)) addType('qualified.type', node.typeName);
        if (ts.isTypePredicateNode(node))
          addType(node.assertsModifier && !node.type ? 'assert.name' : 'predicate.name', node.parameterName);
        if (ts.isTypeParameterDeclaration(node) && !ts.isMappedTypeNode(node.parent))
          addType('generic.name', node.name);
        if (ts.isMappedTypeNode(node)) {
          addType('mapped.name', node.typeParameter.name);
          addType('mapped.type', node.typeParameter.constraint!);
          addType('mapped.alias', node.nameType!);
        }
        if (ts.isExpressionWithTypeArguments(node) && ts.isHeritageClause(node.parent)) {
          if (ts.isClassDeclaration(node.parent.parent) && node.typeArguments)
            types.push(['heritage', node.expression.getEnd(), node.getEnd()]);
          if (ts.isInterfaceDeclaration(node.parent.parent)) addType('interface.name', node.expression);
        }
        ts.forEachChild(node, visit);
      };
      visit(reference);
      expect(current.rootNode.hasError).toBe(false);
      expect(
        current.rootNode.descendantsOfType('new_expression').flatMap((node) => {
          const ctor = node.childForFieldName('constructor');
          return ctor?.type === 'identifier' ? [[ctor.text, ctor.startIndex, ctor.endIndex]] : [];
        })
      ).toEqual(constructors);
      expect(
        current.rootNode
          .descendantsOfType(['as_expression', 'satisfies_expression'])
          .map((node) => [node.type === 'as_expression' ? 'as' : 'satisfies', node.startIndex, node.endIndex])
      ).toEqual(assertions);
      expect(collectTypeRoles(current.rootNode, dialect === 'tsx')).toEqual(types);
    }
  });
}

function collectTypeRoles(root: Node, includeJsx: boolean): [string, number, number][] {
  const roles: [string, number, number][] = [];
  const push = (name: string, node: Node | null | undefined): void => {
    if (node) roles.push([name, node.startIndex, node.endIndex]);
  };
  walkNodes(root, (node) => {
    if (node.type === 'parenthesized_type') push('parenthesized', node);
    else if (node.type === 'type_query') push('query.value', firstNonExtraNamedChild(node));
    else if (node.type === 'mapped_type_clause') {
      const name = node.childForFieldName('name');
      if (name?.type === 'type_identifier') {
        push('mapped.name', name);
        push('mapped.type', node.childForFieldName('type'));
        push('mapped.alias', node.childForFieldName('alias'));
      }
    } else if (node.type === 'extends_clause') {
      const args = node.childForFieldName('type_arguments');
      if (args?.type === 'type_arguments') push('heritage', args);
    } else if (node.type === 'extends_type_clause') {
      const type = node.childForFieldName('type');
      if (type?.type === 'type_identifier') push('interface.name', type);
    } else if (
      (node.type === 'required_parameter' || node.type === 'optional_parameter') &&
      node.parent?.type === 'tuple_type'
    ) {
      const label = node.childForFieldName('name');
      const leaf = label?.type === 'rest_pattern' ? firstNonExtraNamedChild(label) : label;
      if (leaf?.type === 'identifier') push('tuple.name', leaf);
    } else if (node.type === 'nested_type_identifier') push('qualified.type', node);
    else if (node.type === 'type_predicate') {
      const name = node.childForFieldName('name');
      if (name?.type === 'identifier') push('predicate.name', name);
    } else if (node.type === 'asserts' && node.isNamed) {
      const first = firstNonExtraNamedChild(node);
      if (first?.type === 'identifier') push('assert.name', first);
    } else if (node.type === 'type_parameter') {
      const name = node.childForFieldName('name');
      if (name?.type === 'type_identifier') push('generic.name', name);
    } else if (
      includeJsx &&
      (node.type === 'jsx_self_closing_element' ||
        node.type === 'jsx_opening_element' ||
        node.type === 'jsx_closing_element')
    ) {
      push('jsx.name', node.childForFieldName('name'));
    }
  });
  return roles;
}
