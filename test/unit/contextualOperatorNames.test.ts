import { Edit, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { compareEditedTree, position } from '../helpers/treeEdit.js';
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
type Mapped = { [as in keyof Keys as as]: Keys[as] };
type Checked = { [satisfies in keyof Keys as satisfies]: Keys[satisfies] };
class Base<T> {}
class Derived extends Base<as[]> {}
interface Inherited extends as {}
`;

for (const dialect of ['typescript', 'tsx']) {
  test(`retains ${dialect} contextual constructor names and operator roles through edits`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser().setLanguage(language);
    const query = new Query(language, '(new_expression constructor: (identifier) @constructor)');
    const operators = new Query(language, '(as_expression) @as\n(satisfies_expression) @satisfies');
    const typeRoles = new Query(
      language,
      `
      (parenthesized_type) @parenthesized
      (mapped_type_clause name: (type_identifier) @mapped.name type: (_) @mapped.type alias: (_) @mapped.alias)
      (extends_clause type_arguments: (type_arguments) @heritage)
      (extends_type_clause type: (type_identifier) @interface.name)
    `
    );
    let source = Source;
    let tree: Tree | undefined;
    try {
      tree = parser.parse(source)!;
      check(tree);
      for (const start of [
        source.indexOf('new as') + 4,
        source.indexOf('Base<as[]>') + 5,
        source.indexOf('[as in') + 1,
      ]) {
        for (const [before, after] of [
          ['as', 'satisfies'],
          ['satisfies', 'as'],
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
              check(incremental, next);
              check(fresh, next);
            }
          );
          previous.delete();
          source = next;
        }
      }
      expect(source).toBe(Source);
    } finally {
      tree?.delete();
      typeRoles.delete();
      operators.delete();
      query.delete();
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
      expect(query.captures(current.rootNode).map(({ node }) => [node.text, node.startIndex, node.endIndex])).toEqual(
        constructors
      );
      expect(
        operators.captures(current.rootNode).map(({ name, node }) => [name, node.startIndex, node.endIndex])
      ).toEqual(assertions);
      expect(
        typeRoles.captures(current.rootNode).map(({ name, node }) => [name, node.startIndex, node.endIndex])
      ).toEqual(types);
    }
  });
}
