import { Edit, Parser, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { configuredQueries } from '../helpers/configuredQueries.js';
import { compareEditedTree, position } from '../helpers/treeEdit.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

const Declarations = [
  'let value: T',
  'let value!: T',
  'type Value = T<string>',
  'type Value = typeof ns.value',
  'type Value = import("m")',
  'function f(): T',
  'function f<T>()',
  'declare function f(): T',
];
const Continuations = [
  'let value: T = left\n+ right;',
  'let value: T = left\n- right;',
  'let value: T = tag\n`text`;',
  'const value = left satisfies T\n+ right;',
  'type Value = T\n| U;',
  'type Value = T\n& U;',
  'type Value = T extends\nU ? Y : N;',
  'type Value = T |\n-1;',
];

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves compiler statement boundaries after ${dialect} typed declarations`, async () => {
    await Parser.init();
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    const expressions = ['+ value;', '-value;', '`text`;', dialect === 'tsx' ? '<div />;' : '<T>value;'];
    try {
      for (const declaration of Declarations) {
        for (const expression of expressions) {
          for (const gap of ['\n', '/*\n*/']) {
            const source = `${declaration}${gap}${expression}\nconst following = 1;`;
            const tree = parser.parse(source)!;
            try {
              checkStatements(tree, source, dialect);
            } finally {
              tree.delete();
            }
          }
        }
      }
      for (const declaration of Continuations) {
        const source = `${declaration}\nconst following = 1;`;
        const tree = parser.parse(source)!;
        try {
          checkStatements(tree, source, dialect);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });

  test(`updates ${dialect} typed declaration boundaries and query ranges through edits`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser().setLanguage(language);
    const queries: ReturnType<typeof configuredQueries> = [];
    const captures = (tree: Tree): unknown =>
      queries.map((query) =>
        query
          .captures(tree.rootNode)
          .map(({ name, node }) => [name, node.type, node.text, node.startIndex, node.endIndex])
      );
    let source = 'let value: T\n+ value;\nconst following = 1;';
    let tree: Tree | undefined;
    try {
      queries.push(...configuredQueries(language, dialect));
      tree = parser.parse(source)!;
      checkStatements(tree, source, dialect);
      for (const next of [
        'let value: T = initial\n+ value;\nconst following = 1;',
        'let value: T\n- value;\nconst following = 1;',
        'type Value = T\n`text`;\nconst following = 1;',
        `function f(): T\n${dialect === 'tsx' ? '<div />' : '<T>value'};\nconst following = 1;`,
        'let value: T\n+ value;\nconst following = 1;',
      ]) {
        let startIndex = 0;
        while (startIndex < source.length && startIndex < next.length && source[startIndex] === next[startIndex])
          startIndex++;
        let oldEndIndex = source.length;
        let newEndIndex = next.length;
        while (
          oldEndIndex > startIndex &&
          newEndIndex > startIndex &&
          source[oldEndIndex - 1] === next[newEndIndex - 1]
        ) {
          oldEndIndex--;
          newEndIndex--;
        }
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex,
            oldEndIndex,
            newEndIndex,
            startPosition: position(source, startIndex),
            oldEndPosition: position(source, oldEndIndex),
            newEndPosition: position(next, newEndIndex),
          }),
          (incremental, fresh) => {
            checkStatements(incremental, next, dialect);
            checkStatements(fresh, next, dialect);
            expect(captures(incremental)).toEqual(captures(fresh));
          }
        );
        previous.delete();
        source = next;
      }
    } finally {
      tree?.delete();
      for (const query of queries) query.delete();
      parser.delete();
    }
  });
}

function checkStatements(tree: Tree, source: string, dialect: string): void {
  const fileName = dialect === 'tsx' ? 'fixture.tsx' : 'fixture.ts';
  expect(
    ts
      .transpileModule(source, {
        fileName,
        reportDiagnostics: true,
        compilerOptions: { jsx: ts.JsxEmit.Preserve },
      })
      .diagnostics?.map((diagnostic) => diagnostic.code) ?? [],
    source
  ).toEqual([]);
  const reference = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  expect(tree.rootNode.hasError, source).toBe(false);
  const statements = tree.rootNode.namedChildren.filter((node) => !node.isExtra);
  expect(
    statements.map((node) => [node.startIndex, node.endIndex, node.text]),
    source
  ).toEqual(reference.statements.map((node) => [node.getStart(reference), node.end, node.getText(reference)]));
  expect(statements.at(-1)!.text).toBe('const following = 1;');
}
