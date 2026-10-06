import { Edit, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

import { compareEditedTree, position } from '../helpers/treeEdit.js';

import { loadCurrentWasmBuild } from './wasmBuild.js';

test('rejects string-named local exports while retaining string re-exports and aliases', async () => {
  await Parser.init();
  for (const dialect of ['typescript', 'tsx']) {
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const name of ['"remote"', "'remote'", '""', String.raw`"\u0061"`]) {
        for (const [statement, modifier] of [
          ['export', ''],
          ['export', 'type '],
          ['export type', ''],
        ]) {
          for (const alias of ['', ' as local']) {
            for (const suffix of ['', ' from "m"']) {
              const source = `${statement} { ${modifier}${name}${alias} }${suffix};`;
              const tree = parser.parse(source)!;
              try {
                expect(tree.rootNode.hasError, source).toBe(!suffix);
                if (suffix) {
                  const specifier = tree.rootNode.descendantsOfType('export_specifier')[0]!;
                  expect(specifier.childForFieldName('name')?.text).toBe(name);
                  expect(specifier.childForFieldName('alias')?.text).toBe(alias ? 'local' : undefined);
                }
              } finally {
                tree.delete();
              }
            }
          }
          const source = `${statement} { ${modifier}local as ${name} };`;
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(false);
            const specifier = tree.rootNode.descendantsOfType('export_specifier')[0]!;
            expect(specifier.childForFieldName('name')?.text).toBe('local');
            expect(specifier.childForFieldName('alias')?.text).toBe(name);
          } finally {
            tree.delete();
          }
        }
      }
    } finally {
      parser.delete();
    }
  }
});

test('updates export validity when adding and removing a from clause', async () => {
  await Parser.init();
  for (const dialect of ['typescript', 'tsx']) {
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const statement of ['export', 'export type']) {
        const prefix = `${statement} { "remote" as local }`;
        let clause = '';
        let tree = parser.parse(prefix + ';')!;
        try {
          expect(tree.rootNode.hasError).toBe(true);
          for (const nextClause of [' from "m"', '', ' from "m"']) {
            const previousSource = prefix + clause + ';';
            const source = prefix + nextClause + ';';
            const next = compareEditedTree(
              parser,
              tree,
              source,
              new Edit({
                startIndex: prefix.length,
                oldEndIndex: prefix.length + clause.length,
                newEndIndex: prefix.length + nextClause.length,
                startPosition: position(previousSource, prefix.length),
                oldEndPosition: position(previousSource, prefix.length + clause.length),
                newEndPosition: position(source, prefix.length + nextClause.length),
              }),
              (incremental) => expect(incremental.rootNode.hasError, source).toBe(!nextClause),
              true
            );
            tree.delete();
            tree = next;
            clause = nextClause;
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
