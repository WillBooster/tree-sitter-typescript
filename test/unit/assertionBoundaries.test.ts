import { Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

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
    const query = new Query(language, '(required_parameter pattern: (identifier) @binding)');
    try {
      parser.setLanguage(language);
      for (const form of ['(x: T)', 'new (x: T)', '()']) {
        const complete = `const result = value as ${form} => A;${Following}`;
        const incomplete = complete.replace(' => A', '');
        for (const [source, valid] of [
          [complete, true],
          [incomplete, false],
        ] as const) {
          const tree = parser.parse(source)!;
          try {
            checkFormalFields(tree, source, dialect, valid, query);
          } finally {
            tree.delete();
          }
        }
      }
    } finally {
      query.delete();
      parser.delete();
    }
  });

  test(`retains ${dialect} postfix boundaries when a comment gains a newline`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser();
    try {
      parser.setLanguage(language);
      for (const statement of [
        'const result = (value as const.Member/* gap */!);',
        'const result = value as A extends const/* gap */! ? C : D;',
        'const result = value as A extends B ? Name/* gap */! : D;',
        'const result = value as const.Member[(Name/* gap */!)];',
      ]) {
        for (const gap of ['\n', ' ']) {
          const source = statement.replace('/* gap', `/*${gap}gap`) + Following;
          const valid = gap === ' ';
          const tree = parser.parse(source)!;
          try {
            referenceFor(source, dialect, valid);
            expect(tree.rootNode.hasError, source).toBe(!valid);
            expect(tree.rootNode.lastNamedChild!.text).toBe('const following = 1;');
          } finally {
            tree.delete();
          }
        }
      }
    } finally {
      parser.delete();
    }
  });

  test(`retains ${dialect} assertion boundaries with small surrounding changes`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser();
    const query = new Query(
      language,
      '(as_expression) @as (call_expression) @call (subscript_expression) @subscript (expression_statement) @statement (regex) @regex'
    );
    try {
      parser.setLanguage(language);
      for (const prefix of ['', 'const earlier = 1;\n']) {
        for (const statement of Statements) {
          const sources = [
            prefix + statement + Following,
            ' ' + prefix + statement + Following,
            prefix + statement + Following.replace('= 1', '= 10'),
          ];
          if (prefix) sources.push('const earlier = 10;\n' + statement + Following);
          if (statement.startsWith('const ')) sources.push(prefix + statement.replace(' ', '\n') + Following);
          for (const source of sources) {
            const tree = parser.parse(source)!;
            try {
              checkBoundaries(tree, source, dialect, query);
            } finally {
              tree.delete();
            }
          }
        }
      }
    } finally {
      query.delete();
      parser.delete();
    }
  });

  test(`preserves tagged constructor fields across ${dialect} type argument lists`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser();
    try {
      parser.setLanguage(language);
      for (const constructor of [
        'F<Inner>`tag`',
        'F<Inner>`tag`.Member',
        'F<Inner>`tag`[key]',
        'F<Inner>`tag`!',
        'new F<Inner>`tag`<Nested>().Member',
      ]) {
        for (const gap of ['', '\n']) {
          for (const call of ['', '()']) {
            for (const argument of ['', 'Arg', '/* gap */', 'Arg,']) {
              const source = `const result = new ${constructor}${gap}<${argument}>${call};${Following}`;
              const tree = parser.parse(source)!;
              try {
                checkConstructorFields(tree, source, dialect, argument === '' || argument === '/* gap */');
              } finally {
                tree.delete();
              }
            }
          }
        }
      }
    } finally {
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
        "a as ([a = /'/]: A) => B;",
        'a as ([a = /]/]: A) => B;',
        'a as ([a = /[(]/]: A) => B;',
        'a as ([a = 1 / 2 / 3]: A) => B;',
        'x = a as ([<T = X>() => T]);',
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
        'a as (keyof ? <T>() => T);',
        'let x: X<keyof .5>;',
        'let x: X<readonly .5[]>;',
        'a as X<keyof.5>;',
        'let x: X<const<T>>;',
        'a as X<class<T>>;',
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
        'a as const.M | | A;',
        'a as const.M & & A;',
        'a as const.M & | A;',
        'a as A extends const.M | | B ? C : D;',
        'a as const.M | & A;',
        'a as A & B;',
        'a as A | & B;',
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
