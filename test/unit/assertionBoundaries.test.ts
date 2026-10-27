import { Edit, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { configuredQueries } from '../helpers/configuredQueries.js';
import { compareEditedTree, position } from '../helpers/treeEdit.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

const Statements = [
  'x = value as const.Member\n(b);',
  'x = value as A!\n(b);',
  'const result = value as A!\n(b);',
  'x = value as const.Member<Arg>\n(b);',
  'x = value as const.Member[]\n[0];',
  'x = value as (const.Member)\n[0];',
  'x = value as () => asserts x[Key]\n(b);',
  'x = value as new () => asserts x[Key]\n(b);',
  'x = value as A\n(b);',
  'x = value as A<Arg>\n(b);',
  'x = value as A[Key]\n(b);',
  'const result = () => value as A; ',
  'const result = value as A ? other : last;',
  'const result = f!`tag`;',
];
const Following = '\nconst following = 1;';

for (const dialect of ['typescript', 'tsx']) {
  test(`retains assertion boundaries after small surrounding ${dialect} edits`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser().setLanguage(language);
    const query = new Query(
      language,
      '(as_expression) @as (call_expression) @call (subscript_expression) @subscript (expression_statement) @statement'
    );
    const configured = configuredQueries(language, dialect);
    const captures = (tree: Tree): unknown =>
      configured.map((item) =>
        item.captures(tree.rootNode).map(({ name, node }) => [name, node.type, node.startIndex, node.endIndex])
      );
    try {
      for (const prefix of ['', 'const earlier = 1;\n']) {
        for (const statement of Statements) {
          let source = prefix + statement + Following;
          let tree = parser.parse(source)!;
          const edit = (start: number, end: number, replacement: string): void => {
            const next = source.slice(0, start) + replacement + source.slice(end);
            const previous = tree;
            tree = compareEditedTree(
              parser,
              previous,
              next,
              new Edit({
                startIndex: start,
                oldEndIndex: end,
                newEndIndex: start + replacement.length,
                startPosition: position(source, start),
                oldEndPosition: position(source, end),
                newEndPosition: position(next, start + replacement.length),
              }),
              (incremental, fresh) => {
                checkBoundaries(incremental, next, dialect, query);
                checkBoundaries(fresh, next, dialect, query);
                expect(captures(incremental)).toEqual(captures(fresh));
              }
            );
            previous.delete();
            source = next;
          };
          try {
            checkBoundaries(tree, source, dialect, query);
            edit(0, 0, ' ');
            edit(0, 1, '');
            const suffix = source.lastIndexOf('1');
            edit(suffix + 1, suffix + 1, '0');
            edit(suffix + 1, suffix + 2, '');
            if (prefix) {
              const earlier = source.indexOf('1');
              edit(earlier + 1, earlier + 1, '0');
              edit(earlier + 1, earlier + 2, '');
            }
            if (statement.startsWith('const ')) {
              const gap = prefix.length + 'const'.length;
              edit(gap, gap + 1, '\n');
              edit(gap, gap + 1, ' ');
            }
          } finally {
            tree.delete();
          }
        }
      }
    } finally {
      query.delete();
      for (const item of configured) item.delete();
      parser.delete();
    }
  });

  test(`preserves tagged constructor fields through empty ${dialect} argument edits`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser().setLanguage(language);
    const queries = configuredQueries(language, dialect);
    const captures = (tree: Tree): unknown =>
      queries.map((query) =>
        query.captures(tree.rootNode).map(({ name, node }) => [name, node.type, node.startIndex, node.endIndex])
      );
    try {
      for (const constructor of [
        'F<Inner>`tag`',
        'F<Inner>`tag`.Member',
        'F<Inner>`tag`[key]',
        'F<Inner>`tag`!',
        'new F<Inner>`tag`<Nested>().Member',
      ]) {
        for (const gap of ['', '\n']) {
          for (const call of ['', '()']) {
            const prefix = `const result = new ${constructor}${gap}<`;
            const sourceFor = (argument: string): string => `${prefix}${argument}>${call};${Following}`;
            let argument = '';
            let source = sourceFor(argument);
            let tree = parser.parse(source)!;
            try {
              checkConstructorFields(tree, source, dialect, true);
              for (const next of ['Arg', '/* gap */', 'Arg,', '']) {
                const nextSource = sourceFor(next);
                const previous = tree;
                tree = compareEditedTree(
                  parser,
                  previous,
                  nextSource,
                  new Edit({
                    startIndex: prefix.length,
                    oldEndIndex: prefix.length + argument.length,
                    newEndIndex: prefix.length + next.length,
                    startPosition: position(source, prefix.length),
                    oldEndPosition: position(source, prefix.length + argument.length),
                    newEndPosition: position(nextSource, prefix.length + next.length),
                  }),
                  (incremental, fresh) => {
                    checkConstructorFields(incremental, nextSource, dialect, next === '' || next === '/* gap */');
                    checkConstructorFields(fresh, nextSource, dialect, next === '' || next === '/* gap */');
                    expect(captures(incremental)).toEqual(captures(fresh));
                  },
                  true
                );
                previous.delete();
                argument = next;
                source = nextSource;
              }
            } finally {
              tree.delete();
            }
          }
        }
      }
    } finally {
      for (const query of queries) query.delete();
      parser.delete();
    }
  });
}

function checkConstructorFields(tree: Tree, source: string, dialect: string, empty: boolean): void {
  const reference = referenceFor(source, dialect);
  const expected: unknown[][] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const children = node.getChildren(reference);
      const delimited = (open: ts.SyntaxKind, close: ts.SyntaxKind): number[] | undefined => {
        const start = children.find((child) => child.kind === open);
        const end = children.find((child) => child.kind === close);
        return start && end ? [start.getStart(reference), end.end] : undefined;
      };
      expected.push([
        [node.getStart(reference), node.end],
        [node.expression.getStart(reference), node.expression.end],
        delimited(ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken),
        delimited(ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.CloseParenToken),
      ]);
    }
    ts.forEachChild(node, collect);
  };
  collect(reference);
  const actual = tree.rootNode.descendantsOfType('new_expression').map((node) => {
    const range = (field: string): number[] | undefined => {
      const child = node.childForFieldName(field);
      return child ? [child.startIndex, child.endIndex] : undefined;
    };
    return [[node.startIndex, node.endIndex], range('constructor'), range('type_arguments'), range('arguments')];
  });
  expect(actual, source).toEqual(expected);
  expect(tree.rootNode.hasError, source).toBe(empty);
  expect(tree.rootNode.descendantsOfType('ERROR'), source).toHaveLength(0);
  const missing = tree.rootNode.descendantsOfType('type_identifier').filter((node) => node.isMissing);
  expect(missing, source).toHaveLength(empty ? 1 : 0);
  expect(tree.rootNode.lastNamedChild?.text).toBe('const following = 1;');
}

function checkBoundaries(tree: Tree, source: string, dialect: string, query: Query): void {
  const reference = referenceFor(source, dialect);
  expect(tree.rootNode.hasError, source).toBe(false);
  expect(tree.rootNode.lastNamedChild!.text).toBe(source.slice(source.lastIndexOf('const following')));
  const expected: [string, number, number][] = [];
  const collect = (node: ts.Node): void => {
    const kind = ts.isAsExpression(node)
      ? 'as'
      : ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)
        ? 'call'
        : ts.isElementAccessExpression(node)
          ? 'subscript'
          : ts.isExpressionStatement(node)
            ? 'statement'
            : undefined;
    if (kind) expected.push([kind, node.getStart(reference), node.end]);
    ts.forEachChild(node, collect);
  };
  collect(reference);
  const actual = query
    .captures(tree.rootNode)
    .map(({ name: capture, node }) => [capture, node.startIndex, node.endIndex]);
  expect(sortRanges(actual), source).toEqual(sortRanges(expected));
}

function sortRanges(rows: unknown[][]): unknown[][] {
  return rows.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function referenceFor(source: string, dialect: string): ts.SourceFile {
  const name = dialect === 'tsx' ? 'boundary.tsx' : 'boundary.ts';
  const reference = ts.createSourceFile(
    name,
    source,
    ts.ScriptTarget.Latest,
    true,
    dialect === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const options = { noLib: true, noResolve: true, jsx: ts.JsxEmit.Preserve };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (file) => (file === name ? reference : undefined);
  const program = ts.createProgram([name], options, host);
  expect(program.getSyntacticDiagnostics(reference), source).toHaveLength(0);
  return reference;
}
