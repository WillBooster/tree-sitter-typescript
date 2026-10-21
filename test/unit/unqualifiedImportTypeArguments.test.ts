import { Edit, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { configuredQueries } from '../helpers/configuredQueries.js';
import { compareEditedTree, position } from '../helpers/treeEdit.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

const Prefix = `type Bare = import("m")<string>;
type Queried = typeof import("m")<string>;
type Nested = Base<import("m")<string>>;
const consumed = consume<import("m")<string>>();
type Qualified = import("m").A<string>;
type QualifiedQuery = typeof import("m").A<string>;
type Indexed = import("m")<string>[number];
type IndexedQuery = typeof import("m")<string>[number];
type Options = import("m", { with: { type: "json" } })<string>;
type InnerComment = import("m"/*\n*/)<string>;
type OuterComment = import("m")/*inline*/<string>;
const dynamic = import("m");
const instantiation = import("m")<string>;
const called = import("m")<string>();
const compared = value as import("m") <= 1;
const shifted = (value as import("m")) << 1;
type Editable = `;
const Suffix = `;
const following = 1;
`;
const InitialType = 'import("m")<string>';

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves unqualified import-type arguments and expression roles through ${dialect} edits`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser().setLanguage(language);
    const query = new Query(
      language,
      '(call_expression function: (import) arguments: (arguments (string) @module) type_arguments: (_) @arguments) @import (variable_declarator value: (instantiation_expression) @instantiation)'
    );
    const queries: Query[] = [];
    const captures = (tree: Tree): unknown =>
      queries.map((compiled) =>
        compiled
          .captures(tree.rootNode)
          .map(({ name, node }) => [name, node.type, node.text, node.startIndex, node.endIndex])
      );
    let annotation = InitialType;
    let source = Prefix + annotation + Suffix;
    let tree: Tree | undefined;
    try {
      queries.push(...configuredQueries(language, dialect));
      tree = parser.parse(source)!;
      checkImports(tree, source, dialect, query);
      for (const nextType of [
        'import("m")<number, string>',
        'typeof import("m")<string>',
        'import("m")<<T>() => T>',
        'import("m")< <T>() => T>',
        'import("m")<string> | number',
        'import("m")/* inline */<string>',
        'import("m" /*\n*/ )<string>',
        'import("m") \t/* inline */ <string>',
        'import("m", { with: { type: "json" } })<string>',
        'import("m").A<string>',
        'import("m")',
        InitialType,
      ]) {
        const next = Prefix + nextType + Suffix;
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex: Prefix.length,
            oldEndIndex: Prefix.length + annotation.length,
            newEndIndex: Prefix.length + nextType.length,
            startPosition: position(source, Prefix.length),
            oldEndPosition: position(source, Prefix.length + annotation.length),
            newEndPosition: position(next, Prefix.length + nextType.length),
          }),
          (incremental, fresh) => {
            checkImports(incremental, next, dialect, query);
            checkImports(fresh, next, dialect, query);
            expect(captures(incremental)).toEqual(captures(fresh));
          }
        );
        previous.delete();
        source = next;
        annotation = nextType;
      }
    } finally {
      tree?.delete();
      query.delete();
      for (const compiled of queries) compiled.delete();
      parser.delete();
    }
  });

  test(`rejects ${dialect} import members after type arguments`, async () => {
    await Parser.init();
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const type of [
        'import("m")<string>.B',
        'import("m")<string>.B<number>',
        'typeof import("m")<string>.x',
        'typeof import("m")<string>.x<number>',
      ]) {
        const source = `type A = ${type};\nconst following = 1;`;
        expect(
          ts
            .transpileModule(source, {
              fileName: dialect === 'tsx' ? 'fixture.tsx' : 'fixture.ts',
              reportDiagnostics: true,
            })
            .diagnostics?.map((diagnostic) => diagnostic.code),
          source
        ).toContain(1005);
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(true);
          expect(tree.rootNode.lastNamedChild!.text, source).toBe('const following = 1;');
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });

  test(`preserves existing ${dialect} import argument expressions without type arguments`, async () => {
    await Parser.init();
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const [argument, kind] of [
        ['x ? "a" : "b"', 'ternary_expression'],
        ['async () => {}', 'arrow_function'],
        ['await x', 'await_expression'],
        ['"m" ? "a" : "b"', 'ternary_expression'],
      ]) {
        for (const gap of ['', ' ', '\n', '/*inline*/', '/*\n*/', '//line\n']) {
          const source = `type A = typeof import(${gap}${argument});\nconst following = 1;`;
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(false);
            expect(tree.rootNode.lastNamedChild!.text).toBe('const following = 1;');
            const argumentsNode = tree.rootNode.descendantsOfType('arguments')[0]!;
            const expression = argumentsNode.namedChildren.find((node) => !node.isExtra)!;
            expect([expression.type, expression.text, expression.startIndex, expression.endIndex], source).toEqual([
              kind,
              argument,
              source.indexOf(argument!, 'type A = typeof import('.length),
              source.indexOf(argument!, 'type A = typeof import('.length) + argument!.length,
            ]);
            expect(
              argumentsNode.namedChildren.filter((node) => node.type === 'comment').map((node) => node.text)
            ).toEqual(gap!.startsWith('/') ? [gap!.trimEnd()] : []);
          } finally {
            tree.delete();
          }
        }
      }
    } finally {
      parser.delete();
    }
  });

  test(`keeps line breaks and legacy comparison prefixes outside ${dialect} import-type arguments`, async () => {
    await Parser.init();
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const gap of ['\n', '\r', '\r\n', '\u2028', '\u2029', '/*\n*/', '//comment\n']) {
        const source = `type T = import("m")${gap}<string>;\nconst following = 1;`;
        expect(
          ts.transpileModule(source, {
            reportDiagnostics: true,
            fileName: dialect === 'tsx' ? 'fixture.tsx' : 'fixture.ts',
          }).diagnostics?.length
        ).toBeGreaterThan(0);
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(true);
          if (dialect === 'typescript') expect(tree.rootNode.lastNamedChild!.text).toBe('const following = 1;');
          expect(
            tree.rootNode
              .descendantsOfType('call_expression')
              .every((node) => !node.childForFieldName('type_arguments'))
          ).toBe(true);
        } finally {
          tree.delete();
        }
      }
      if (dialect === 'tsx') {
        const jsxSource = 'type T = import("m")\n<string />;\nconst following = 1;';
        expect(
          ts.transpileModule(jsxSource, {
            reportDiagnostics: true,
            fileName: 'fixture.tsx',
            compilerOptions: { jsx: ts.JsxEmit.Preserve },
          }).diagnostics ?? []
        ).toEqual([]);
        const jsxTree = parser.parse(jsxSource)!;
        try {
          expect(jsxTree.rootNode.lastNamedChild!.text).toBe('const following = 1;');
          expect(jsxTree.rootNode.descendantsOfType('jsx_self_closing_element').map((node) => node.text)).toEqual([
            '<string />',
          ]);
        } finally {
          jsxTree.delete();
        }
      }
      const source = 'const result = value as import("m")<!--comment\nconst following = 1;';
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.lastNamedChild!.text).toBe('const following = 1;');
        expect(tree.rootNode.hasError).toBe(false);
        expect(
          tree.rootNode.descendantsOfType('call_expression').every((node) => !node.childForFieldName('type_arguments'))
        ).toBe(true);
      } finally {
        tree.delete();
      }
    } finally {
      parser.delete();
    }
  });
}

function checkImports(tree: Tree, source: string, dialect: string, query: Query): void {
  expect(
    ts.transpileModule(source, { reportDiagnostics: true, fileName: dialect === 'tsx' ? 'fixture.tsx' : 'fixture.ts' })
      .diagnostics ?? [],
    source
  ).toEqual([]);
  expect(tree.rootNode.hasError, source).toBe(false);
  const reference = ts.createSourceFile(
    `fixture.${dialect === 'tsx' ? 'tsx' : 'ts'}`,
    source,
    ts.ScriptTarget.Latest,
    true
  );
  const expected: Record<string, (string | number)[][]> = { import: [], module: [], arguments: [], instantiation: [] };
  const visit = (node: ts.Node): void => {
    if (ts.isImportTypeNode(node) && !node.qualifier && node.typeArguments?.length) {
      const start = node
        .getChildren(reference)
        .find((child) => child.kind === ts.SyntaxKind.ImportKeyword)!
        .getStart(reference);
      const argumentsStart = node.typeArguments.pos - 1;
      expected.import!.push([source.slice(start, node.end), start, node.end]);
      expected.module!.push([node.argument.getText(reference), node.argument.getStart(reference), node.argument.end]);
      expected.arguments!.push([source.slice(argumentsStart, node.end), argumentsStart, node.end]);
    }
    if (ts.isExpressionWithTypeArguments(node))
      expected.instantiation!.push([node.getText(reference), node.getStart(reference), node.end]);
    ts.forEachChild(node, visit);
  };
  visit(reference);
  const captures = query.captures(tree.rootNode);
  for (const [name, ranges] of Object.entries(expected)) {
    expect(
      captures
        .filter((capture) => capture.name === name)
        .map(({ node }) => [node.text, node.startIndex, node.endIndex]),
      source
    ).toEqual(ranges);
  }
  expect(tree.rootNode.lastNamedChild!.text).toBe('const following = 1;');
}
