import { Edit, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { configuredQueries } from '../helpers/configuredQueries.js';
import { compareEditedTree, position } from '../helpers/treeEdit.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

const Statements = [
  String.raw`function f(){ return /<(a|strong|b|em|i|h[1-6]|code|pre|ul|ol|li|blockquote|del|s|strike|img|hr)\b/i.test(value); }`,
  'function f(){ return /<A>/i.test(value); }',
  'const result = /<const/.test(value);',
  'const result = `<A>${value}`;',
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
  test(`retains ${dialect} parameter fields while an assertion arrow is incomplete`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser();
    const ownedQueries: Query[] = [];
    try {
      parser.setLanguage(language);
      const query = new Query(language, '(required_parameter pattern: (pattern/identifier) @binding)');
      ownedQueries.push(query);
      const queries = configuredQueries(language, dialect);
      ownedQueries.push(...queries);
      for (const form of ['(x: T)', 'new (x: T)', '()']) {
        const complete = `const result = value as ${form} => A;${Following}`;
        const start = complete.indexOf(' => A');
        const incomplete = complete.slice(0, start) + complete.slice(start + ' => A'.length);
        let source = complete;
        let tree = parser.parse(source)!;
        try {
          checkFormalFields(tree, source, dialect, true, query);
          for (const [next, valid] of [
            [incomplete, false],
            [complete, true],
          ] as const) {
            const previous = tree;
            const oldEnd = start + (valid ? 0 : ' => A'.length);
            const newEnd = start + (valid ? ' => A'.length : 0);
            tree = compareEditedTree(
              parser,
              previous,
              next,
              new Edit({
                startIndex: start,
                oldEndIndex: oldEnd,
                newEndIndex: newEnd,
                startPosition: position(source, start),
                oldEndPosition: position(source, oldEnd),
                newEndPosition: position(next, newEnd),
              }),
              (incremental, fresh) => {
                checkFormalFields(incremental, next, dialect, valid, query);
                checkFormalFields(fresh, next, dialect, valid, query);
                for (const configured of queries)
                  expect(
                    configured
                      .captures(incremental.rootNode)
                      .map(({ name, node }) => [name, node.type, node.startIndex, node.endIndex])
                  ).toEqual(
                    configured
                      .captures(fresh.rootNode)
                      .map(({ name, node }) => [name, node.type, node.startIndex, node.endIndex])
                  );
              },
              true
            );
            previous.delete();
            source = next;
          }
        } finally {
          tree.delete();
        }
      }
    } finally {
      for (const query of ownedQueries) query.delete();
      parser.delete();
    }
  });

  test(`retains ${dialect} postfix boundaries when a comment gains a newline`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser();
    const ownedQueries: Query[] = [];
    try {
      parser.setLanguage(language);
      const queries = configuredQueries(language, dialect);
      ownedQueries.push(...queries);
      const captures = (tree: Tree): unknown =>
        queries.map((query) =>
          query.captures(tree.rootNode).map(({ name, node }) => [name, node.type, node.startIndex, node.endIndex])
        );
      for (const statement of [
        'const result = (value as const.Member/* gap */!);',
        'const result = value as A extends const/* gap */! ? C : D;',
        'const result = value as A extends B ? Name/* gap */! : D;',
        'const result = value as const.Member[(Name/* gap */!)];',
      ]) {
        let source = statement + Following;
        let tree = parser.parse(source)!;
        try {
          for (const gap of ['\n', ' ']) {
            const start = source.indexOf('/*') + 2;
            const next = source.slice(0, start) + gap + source.slice(start + 1);
            const valid = gap === ' ';
            const check = (candidate: Tree): void => {
              referenceFor(next, dialect, valid);
              expect(candidate.rootNode.hasError, next).toBe(!valid);
              expect(candidate.rootNode.lastNamedChild!.text).toBe('const following = 1;');
            };
            const previous = tree;
            tree = compareEditedTree(
              parser,
              previous,
              next,
              new Edit({
                startIndex: start,
                oldEndIndex: start + 1,
                newEndIndex: start + 1,
                startPosition: position(source, start),
                oldEndPosition: position(source, start + 1),
                newEndPosition: position(next, start + 1),
              }),
              (incremental, fresh) => {
                check(incremental);
                check(fresh);
                expect(captures(incremental)).toEqual(captures(fresh));
              },
              true
            );
            previous.delete();
            source = next;
          }
        } finally {
          tree.delete();
        }
      }
    } finally {
      for (const query of ownedQueries) query.delete();
      parser.delete();
    }
  });

  test(`retains assertion boundaries after small surrounding ${dialect} edits`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser();
    const ownedQueries: Query[] = [];
    try {
      parser.setLanguage(language);
      const query = new Query(
        language,
        '(as_expression) @as (call_expression) @call (subscript_expression) @subscript (expression_statement) @statement (regex) @regex'
      );
      ownedQueries.push(query);
      const configured = configuredQueries(language, dialect);
      ownedQueries.push(...configured);
      const captures = (tree: Tree): unknown =>
        configured.map((item) =>
          item.captures(tree.rootNode).map(({ name, node }) => [name, node.type, node.startIndex, node.endIndex])
        );
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
      for (const query of ownedQueries) query.delete();
      parser.delete();
    }
  });

  test(`preserves tagged constructor fields through empty ${dialect} argument edits`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser();
    const ownedQueries: Query[] = [];
    try {
      parser.setLanguage(language);
      const queries = configuredQueries(language, dialect);
      ownedQueries.push(...queries);
      const captures = (tree: Tree): unknown =>
        queries.map((query) =>
          query.captures(tree.rootNode).map(({ name, node }) => [name, node.type, node.startIndex, node.endIndex])
        );
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
      for (const query of ownedQueries) query.delete();
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

function checkFormalFields(tree: Tree, source: string, dialect: string, valid: boolean, query: Query): void {
  const reference = referenceFor(source, dialect, valid);
  const types: (ts.FunctionTypeNode | ts.ConstructorTypeNode)[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node)) types.push(node);
    ts.forEachChild(node, collect);
  };
  collect(reference);
  expect(types).toHaveLength(1);
  const type = types[0]!;
  const tokens = type.getChildren(reference);
  const open = tokens.find((node) => node.kind === ts.SyntaxKind.OpenParenToken)!;
  const close = tokens.find((node) => node.kind === ts.SyntaxKind.CloseParenToken)!;
  const parameters = tree.rootNode.descendantsOfType('formal_parameters');
  expect(parameters).toHaveLength(1);
  const formal = parameters[0]!;
  expect([formal.startIndex, formal.endIndex]).toEqual([open.getStart(reference), close.end]);
  expect(
    formal.namedChildren.map((node) => {
      const pattern = node.childForFieldName('pattern')!;
      const annotation = node.childForFieldName('type')!.namedChild(0)!;
      return [
        node.startIndex,
        node.endIndex,
        pattern.startIndex,
        pattern.endIndex,
        annotation.startIndex,
        annotation.endIndex,
      ];
    })
  ).toEqual(
    type.parameters.map((node) => [
      node.getStart(reference),
      node.end,
      node.name.getStart(reference),
      node.name.end,
      node.type!.getStart(reference),
      node.type!.end,
    ])
  );
  expect(query.captures(tree.rootNode).map(({ node }) => [node.startIndex, node.endIndex])).toEqual(
    type.parameters.map((node) => [node.name.getStart(reference), node.name.end])
  );
  const following = reference.statements.at(-1)!;
  expect([tree.rootNode.lastNamedChild!.startIndex, tree.rootNode.lastNamedChild!.endIndex]).toEqual([
    following.getStart(reference),
    following.end,
  ]);
  expect(tree.rootNode.hasError).toBe(!valid);
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
            : ts.isRegularExpressionLiteral(node)
              ? 'regex'
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

function referenceFor(source: string, dialect: string, valid = true): ts.SourceFile {
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
  expect(program.getSyntacticDiagnostics(reference).length === 0, source).toBe(valid);
  return reference;
}

for (const dialect of ['typescript', 'tsx']) {
  test(`ends ${dialect} assertion names at U+0085 like TypeScript`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser();
    try {
      parser.setLanguage(language);
      for (const source of ['a as T\u0085;', 'a as const.M\u0085;', 'a as typeof b\u0085;', 'a as A.B\u0085;']) {
        const tree = parser.parse(source)!;
        try {
          expect(
            ts.transpileModule(source, { fileName: `a.${dialect === 'tsx' ? 'tsx' : 'ts'}`, reportDiagnostics: true })
              .diagnostics
          ).toHaveLength(0);
          expect(tree.rootNode.hasError, JSON.stringify(source)).toBe(false);
          const type = tree.rootNode.descendantsOfType('as_expression')[0]!.lastNamedChild!;
          expect(type.text).toBe(source.slice('a as '.length, source.indexOf('\u0085')));
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });
}

for (const dialect of ['typescript', 'tsx']) {
  test(`matches TypeScript syntax validity at ${dialect} assertion boundaries`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser();
    try {
      parser.setLanguage(language);
      for (const source of [
        'x = a as ([a]: A) => void;',
        'x = a as ([a, b]) => void;',
        'x = a as ([]: A) => void;',
        'x = a as ([a]?: A) => void;',
        'x = a as ([a] = [1]) => void;',
        'x = a as ([a /* ] */]: A) => B;',
        'x = a as ([a, // ]\nb]: A) => B;',
        'a as ([A /* ]: */]);',
        'x = a as ([a/*x*//*y*/]: A) => B;',
        'x = a as ([A] | B);',
        'x = a as ([A][]);',
        'a as A asT;',
        'a as A satisfiesT;',
        'a as A instanceofT;',
        'a as A as T;',
        'a as (keyof ?);',
        'a as (readonly ?);',
        'a as (unique ?);',
        'a as (unique ? A);',
        'a as (unique ? !A);',
        'a as (unique ? -1);',
        'type U = A extends infer U ? const<T> : T;',
        'type U = A extends infer U ? class<T> : T;',
        'type U = A extends infer U ? in<T, U> : Y;',
        'a as (keyof ?) => A;',
        'a as (keyof A);',
        'a as (bigint.M);',
        'a as (bigint.M.N)[];',
        'a as (bigint.M) | A;',
        'a as (never.M);',
        'a as (unique.M);',
        'a as Box<in>!;',
        'a as !Box<class.Member>;',
        'a as Box<A>!;',
      ]) {
        const valid =
          ts.transpileModule(source, { fileName: `a.${dialect === 'tsx' ? 'tsx' : 'ts'}`, reportDiagnostics: true })
            .diagnostics!.length === 0;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(!valid);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });
}
