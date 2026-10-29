import { Parser, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

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

  test(`preserves ${dialect} typed declaration boundaries before initializers and spaced operators`, async () => {
    await Parser.init();
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const source of [
        'let value: T = initial\n+ value;\nconst following = 1;',
        'let value: T\n- value;\nconst following = 1;',
        'type Value = T\n`text`;\nconst following = 1;',
      ]) {
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
