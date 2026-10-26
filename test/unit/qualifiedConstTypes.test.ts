import { Edit, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { configuredQueries } from '../helpers/configuredQueries.js';
import { compareEditedTree, position } from '../helpers/treeEdit.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

type Ranges = [string, number, number][];
const Sources = [
  'const result = value as const.class;',
  'const result = value as const /* namespace */ . Member;',
  'const result = value as const\n.Member;',
  'const result = value as const.Member.Nested;',
  'const result = value as const.Member<Arg>;',
  'const result = value as const.Member.Nested<Arg>;',
  'const result = value as const.Member[];',
  'const result = value as const.Member[Key];',
  'const result = value as const.Member<Arg>[Key][];',
  'const result = value as const.Member<typeof Namespace.value>;',
  'const result = value as const.Member[typeof Namespace.value];',
  'const result = value as const.Member[] | Other;',
  'const result = value as const.Member[Key] & Other | Third;',
  'const result = value as const.Member extends Base ? Left : Right;',
  'const result = value as const.Member[Key] extends Base ? Left : Right;',
  'const result = value as const.Member <= other;',
  'const result = (value as const.Member) << other;',
  'const result = value as const.Member\n[Key];',
  'const result = value as const.Member /* gap */ [Key];',
  'const result = value as Namespace.const.Member;',
  'const result = value as Namespace.Member.const;',
  'const result = value as const;',
  'const result = (value as const).class;',
  'const result = value as const[Key];',
  'const result = value as const<Arg>;',
  'const result = value as const.Member + other;',
  'const result = value as const.Member as Other;',
];
const InvalidContexts = [
  'type Result = Box<const.Member>;',
  'type Result = [const.Member];',
  'type Result = T extends X ? const.Member : Y;',
  'class Result implements const.Member {}',
  'const invalid = value as const.Member[].field;',
  'const invalid = value as const.Member < other;',
  'const invalid = value as const.Member << other;',
];
const Following = '\nconst following = 1;';

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves qualified const type ranges through ${dialect} edits`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser().setLanguage(language);
    const query = new Query(
      language,
      '(nested_type_identifier) @qualified (generic_type) @generic (as_expression) @as (satisfies_expression) @satisfies ' +
        '(array_type) @array (lookup_type) @lookup (union_type) @union (intersection_type) @intersection (conditional_type) @conditional ' +
        '(type_query) @typeQuery (type_query (member_expression) @queryOperand)' +
        ' (as_expression (type) @assertedType) (array_type (primary_type) @arrayOperand)' +
        ' (lookup_type (primary_type) @lookupOperand "[") (conditional_type left: (type) @conditionalLeft)' +
        (dialect === 'typescript' ? ' (type_assertion) @angle' : '')
    );
    const queries = configuredQueries(language, dialect);
    const sources = [...Sources, ...(dialect === 'typescript' ? ['const result = <const>value;'] : [])].map(
      (source) => source + Following
    );
    const invalidSources = InvalidContexts.map((source) => source + '\n' + Sources[0] + Following);
    const captures = (tree: Tree): unknown =>
      queries.map((configured) =>
        configured
          .captures(tree.rootNode)
          .map(({ name, node }) => [name, node.type, node.text, node.startIndex, node.endIndex])
      );
    let source = sources[0]!;
    let tree: Tree | undefined;
    try {
      tree = parser.parse(source)!;
      checkRanges(tree, source, dialect, query);
      for (const next of [...sources.slice(1), ...invalidSources, sources[0]!]) {
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex: 0,
            oldEndIndex: source.length - Following.length,
            newEndIndex: next.length - Following.length,
            startPosition: { row: 0, column: 0 },
            oldEndPosition: position(source, source.length - Following.length),
            newEndPosition: position(next, next.length - Following.length),
          }),
          (incremental, fresh) => {
            checkRanges(incremental, next, dialect, query, !invalidSources.includes(next));
            checkRanges(fresh, next, dialect, query, !invalidSources.includes(next));
            expect(captures(incremental)).toEqual(captures(fresh));
          },
          true
        );
        previous.delete();
        source = next;
      }
    } finally {
      tree?.delete();
      query.delete();
      for (const configured of queries) configured.delete();
      parser.delete();
    }
  });
}

function checkRanges(tree: Tree, source: string, dialect: string, query: Query, valid = true): void {
  const fileName = dialect === 'tsx' ? 'const.tsx' : 'const.ts';
  const diagnostics = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.Latest },
  }).diagnostics;
  expect(diagnostics?.length === 0, source).toBe(valid);
  expect(tree.rootNode.hasError, source).toBe(!valid);
  expect(tree.rootNode.lastNamedChild!.text).toBe('const following = 1;');
  if (!valid) return;
  const reference = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    dialect === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const expected: Record<string, Ranges> = {
    qualified: [],
    generic: [],
    as: [],
    satisfies: [],
    angle: [],
    array: [],
    lookup: [],
    union: [],
    intersection: [],
    conditional: [],
    typeQuery: [],
    queryOperand: [],
    assertedType: [],
    arrayOperand: [],
    lookupOperand: [],
    conditionalLeft: [],
  };
  const collect = (node: ts.Node): void => {
    if (ts.isAsExpression(node))
      expected.assertedType!.push([node.type.getText(reference), node.type.getStart(reference), node.type.end]);
    const operand = ts.isArrayTypeNode(node)
      ? node.elementType
      : ts.isIndexedAccessTypeNode(node)
        ? node.objectType
        : undefined;
    if (operand)
      expected[ts.isArrayTypeNode(node) ? 'arrayOperand' : 'lookupOperand']!.push([
        operand.getText(reference),
        operand.getStart(reference),
        operand.end,
      ]);
    if (ts.isConditionalTypeNode(node))
      expected.conditionalLeft!.push([
        node.checkType.getText(reference),
        node.checkType.getStart(reference),
        node.checkType.end,
      ]);
    if (ts.isTypeQueryNode(node)) {
      expected.typeQuery!.push([node.getText(reference), node.getStart(reference), node.end]);
      expected.queryOperand!.push([
        node.exprName.getText(reference),
        node.exprName.getStart(reference),
        node.exprName.end,
      ]);
    }
    if (ts.isTypeReferenceNode(node) && node.typeArguments) {
      expected.generic!.push([node.getText(reference), node.getStart(reference), node.end]);
    }
    const typeKind = ts.isArrayTypeNode(node)
      ? 'array'
      : ts.isIndexedAccessTypeNode(node)
        ? 'lookup'
        : ts.isUnionTypeNode(node)
          ? 'union'
          : ts.isIntersectionTypeNode(node)
            ? 'intersection'
            : ts.isConditionalTypeNode(node)
              ? 'conditional'
              : undefined;
    if (typeKind) expected[typeKind]!.push([node.getText(reference), node.getStart(reference), node.end]);
    if (ts.isTypeReferenceNode(node) && ts.isQualifiedName(node.typeName)) {
      expected.qualified!.push([
        node.typeName.getText(reference),
        node.typeName.getStart(reference),
        node.typeName.end,
      ]);
    } else if (ts.isExpressionWithTypeArguments(node) && ts.isPropertyAccessExpression(node.expression)) {
      expected.qualified!.push([
        node.expression.getText(reference),
        node.expression.getStart(reference),
        node.expression.end,
      ]);
    }
    const kind = ts.isAsExpression(node)
      ? 'as'
      : ts.isSatisfiesExpression(node)
        ? 'satisfies'
        : ts.isTypeAssertionExpression(node)
          ? 'angle'
          : undefined;
    if (kind) expected[kind]!.push([node.getText(reference), node.getStart(reference), node.end]);
    ts.forEachChild(node, collect);
  };
  collect(reference);
  const actual: Record<string, Ranges> = Object.fromEntries(Object.keys(expected).map((name) => [name, []]));
  for (const { name, node } of query.captures(tree.rootNode)) {
    actual[name]!.push([node.text, node.startIndex, node.endIndex]);
  }
  const byRange = (a: Ranges[number], b: Ranges[number]): number => a[1] - b[1] || b[2] - a[2];
  for (const name of Object.keys(expected)) {
    expect(actual[name]!.toSorted(byRange), `${name}: ${source}`).toEqual(expected[name]!.toSorted(byRange));
  }
}
