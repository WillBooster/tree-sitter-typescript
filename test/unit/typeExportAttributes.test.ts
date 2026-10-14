import { Edit, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

import { compareEditedTree, position } from '../helpers/treeEdit.js';

import { loadCurrentWasmBuild } from './wasmBuild.js';

test('retains attributes on named, star and namespace type re-exports', async () => {
  await Parser.init();
  for (const dialect of ['typescript', 'tsx']) {
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const clause of ['{ A as B }', '*', '* as ns']) {
        for (const keyword of ['with', 'assert']) {
          for (const separator of keyword === 'with' ? [' ', '\n', ' /* c */\n'] : [' ']) {
            const attribute = `${keyword} { "resolution-mode": "import" }`;
            const source = `export type ${clause} from "m"${separator}${attribute};\nconst after = 1;`;
            const tree = parser.parse(source)!;
            try {
              expect(tree.rootNode.hasError, source).toBe(false);
              const [statement, following] = tree.rootNode.namedChildren;
              expect(statement?.type).toBe('export_statement');
              expect(statement?.childForFieldName('source')?.text).toBe('"m"');
              expect(statement?.descendantsOfType('import_attribute').map((node) => node.text)).toEqual([attribute]);
              expect(following?.text).toBe('const after = 1;');
              if (clause.startsWith('{')) {
                const specifier = statement?.descendantsOfType('export_specifier')[0];
                expect(specifier?.childForFieldName('name')?.text).toBe('A');
                expect(specifier?.childForFieldName('alias')?.text).toBe('B');
              } else if (clause.includes('as')) {
                expect(statement?.descendantsOfType('namespace_export')[0]?.text).toBe('* as ns');
              }
            } finally {
              tree.delete();
            }
          }
        }
      }
    } finally {
      parser.delete();
    }
  }
});

test('preserves type re-export attributes when their keyword crosses a newline', async () => {
  await Parser.init();
  for (const dialect of ['typescript', 'tsx']) {
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const clause of ['{ A }', '*', '* as ns']) {
        const prefix = `export type ${clause} from "m"`;
        const suffix = 'with { "resolution-mode": "import" };\nconst after = 1;';
        let separator = ' ';
        let source = prefix + separator + suffix;
        let tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError).toBe(false);
          for (const nextSeparator of ['\n', ' /* c */\n', ' ']) {
            const nextSource = prefix + nextSeparator + suffix;
            const next = compareEditedTree(
              parser,
              tree,
              nextSource,
              new Edit({
                startIndex: prefix.length,
                oldEndIndex: prefix.length + separator.length,
                newEndIndex: prefix.length + nextSeparator.length,
                startPosition: position(source, prefix.length),
                oldEndPosition: position(source, prefix.length + separator.length),
                newEndPosition: position(nextSource, prefix.length + nextSeparator.length),
              }),
              (updated) => {
                expect(updated.rootNode.namedChildren[0]?.descendantsOfType('import_attribute')).toHaveLength(1);
                expect(updated.rootNode.namedChildren[1]?.text).toBe('const after = 1;');
              }
            );
            tree.delete();
            tree = next;
            source = nextSource;
            separator = nextSeparator;
          }
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  }
});

test('separates a following with statement from re-export attributes', async () => {
  await Parser.init();
  for (const dialect of ['typescript', 'tsx']) {
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const declaration of [
        'export type { A }',
        'export type *',
        'export type * as ns',
        'export { A }',
        'import { A }',
      ]) {
        for (const trivia of [' ', '\n', ' /* c */ ', ' // c\n']) {
          const prefix = `${declaration} from "m"\n`;
          const statement = `with${trivia}(x) { use(x); }`;
          const source = prefix + statement;
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(false);
            expect(tree.rootNode.namedChildren[0]?.descendantsOfType('import_attribute')).toHaveLength(0);
            expect(tree.rootNode.namedChildren[1]?.type).toBe('with_statement');
            expect(tree.rootNode.namedChildren[1]?.text).toBe(statement);
          } finally {
            tree.delete();
          }
          const attribute = `with${trivia}{ type: "json" }`;
          const attributeTree = parser.parse(`${prefix}${attribute};\nconst after = 1;`)!;
          try {
            expect(attributeTree.rootNode.hasError, attribute).toBe(false);
            expect(attributeTree.rootNode.namedChildren[0]?.descendantsOfType('import_attribute')[0]?.text).toBe(
              attribute
            );
            expect(attributeTree.rootNode.namedChildren[1]?.text).toBe('const after = 1;');
          } finally {
            attributeTree.delete();
          }
        }
      }
    } finally {
      parser.delete();
    }
  }
});
