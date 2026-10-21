import { Edit, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { configuredQueries } from '../helpers/configuredQueries.js';
import { compareEditedTree, position } from '../helpers/treeEdit.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

type CaptureRange = [string, number, number];

const Words = ['keyof', 'readonly', 'unique', 'infer'];
const Gaps = [' ', '\n', '\r\n', '\u2028', '\u2029', '/* comment */', '// comment\n'];
const Header = Words.map((word) => `interface ${word}<T = unknown> {}`).join('\n') + '\n';
const Suffix = ' { field = 1; method() { return this.field; } }\nconst following = 1;';
const RoleQuery = `
  (implements_clause (type) @type)
  (implements_clause (primary_type) @primary)
  (implements_clause (type_identifier) @name)
  (implements_clause (generic_type name: (type_identifier) @name))
`;

for (const dialect of ['typescript', 'tsx']) {
  test(`parses contextual ${dialect} implements names with their compiler roles`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser().setLanguage(language);
    const roles = new Query(language, RoleQuery);
    try {
      for (const word of Words) {
        for (const gap of Gaps) {
          const source =
            Header +
            `class C implements ${word}${gap}{ field = 1; }\n` +
            `class Generic implements ${word}${gap}<number> {}\n` +
            `class Multiple implements ${word}, readonly<string> {}\n` +
            `interface Extended extends ${word} {}\nconst following = 1;`;
          const tree = parser.parse(source)!;
          try {
            checkHeritage(tree, source, dialect, roles);
          } finally {
            tree.delete();
          }
        }
      }
    } finally {
      roles.delete();
      parser.delete();
    }
  });

  test(`updates ${dialect} implements names and captures through edits`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser().setLanguage(language);
    const roles = new Query(language, RoleQuery);
    const queries: ReturnType<typeof configuredQueries> = [];
    const prefix = Header + 'class C implements ';
    let word = 'readonly';
    let source = prefix + word + Suffix;
    let tree: Tree | undefined;
    try {
      queries.push(...configuredQueries(language, dialect));
      tree = parser.parse(source)!;
      checkHeritage(tree, source, dialect, roles);
      for (const nextWord of ['keyof', 'unique', 'infer', 'readonly']) {
        const next = prefix + nextWord + Suffix;
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex: prefix.length,
            oldEndIndex: prefix.length + word.length,
            newEndIndex: prefix.length + nextWord.length,
            startPosition: position(source, prefix.length),
            oldEndPosition: position(source, prefix.length + word.length),
            newEndPosition: position(next, prefix.length + nextWord.length),
          }),
          (incremental, fresh) => {
            checkHeritage(incremental, next, dialect, roles);
            checkHeritage(fresh, next, dialect, roles);
            for (const query of queries) {
              const captures = (parsed: Tree): unknown =>
                query
                  .captures(parsed.rootNode)
                  .map(({ name, node }) => [name, node.type, node.text, node.startIndex, node.endIndex]);
              expect(captures(incremental)).toEqual(captures(fresh));
            }
          }
        );
        previous.delete();
        source = next;
        word = nextWord;
      }
    } finally {
      tree?.delete();
      for (const query of queries) query.delete();
      roles.delete();
      parser.delete();
    }
  });
}

function checkHeritage(tree: Tree, source: string, dialect: string, roles: Query): void {
  const fileName = dialect === 'tsx' ? 'fixture.tsx' : 'fixture.ts';
  const reference = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  expect(
    ts
      .transpileModule(source, { fileName, reportDiagnostics: true })
      .diagnostics?.map((diagnostic) => diagnostic.code) ?? [],
    source
  ).toEqual([]);
  expect(tree.rootNode.hasError, source).toBe(false);
  const expected: CaptureRange[] = [];
  for (const statement of reference.statements) {
    if (!ts.isClassDeclaration(statement)) continue;
    const parsed = tree.rootNode
      .descendantsOfType('class_declaration')
      .find((node) => node.childForFieldName('name')?.text === statement.name?.text);
    expect(parsed, source).toBeDefined();
    const body = parsed!.childForFieldName('body')!;
    expect([body.type, body.startIndex, body.endIndex], source).toEqual([
      'class_body',
      statement
        .getChildren(reference)
        .find((child) => child.kind === ts.SyntaxKind.OpenBraceToken)!
        .getStart(reference),
      statement.end,
    ]);
    for (const clause of statement.heritageClauses ?? []) {
      for (const type of clause.types) {
        expected.push(['type', type.getStart(reference), type.end]);
        expected.push(['primary', type.getStart(reference), type.end]);
        expected.push(['name', type.expression.getStart(reference), type.expression.end]);
      }
    }
  }
  const actual = roles.captures(tree.rootNode).map(({ name, node }): CaptureRange => {
    if (name === 'name') expect(node.childCount, source).toBe(0);
    return [name, node.startIndex, node.endIndex];
  });
  expect(actual.toSorted(compareCaptureRange), source).toEqual(expected.toSorted(compareCaptureRange));
  expect(tree.rootNode.lastNamedChild?.text, source).toBe('const following = 1;');
}

function compareCaptureRange(left: CaptureRange, right: CaptureRange): number {
  return left[0].localeCompare(right[0]) || left[1] - right[1] || left[2] - right[2];
}
