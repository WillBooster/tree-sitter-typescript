import { Edit, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

import { loadCurrentWasmBuild } from './wasmBuild.js';

test('rejects string-named local exports while retaining string re-exports and aliases', async () => {
  await Parser.init();
  for (const dialect of ['typescript', 'tsx']) {
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const name of ['"remote"', "'remote'", '""', String.raw`"\u0061"`]) {
        for (const modifier of ['', 'type ']) {
          for (const alias of ['', ' as local']) {
            for (const suffix of ['', ' from "m"']) {
              const source = `export { ${modifier}${name}${alias} }${suffix};`;
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
          const source = `export { ${modifier}local as ${name} };`;
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
    const prefix = 'export { "remote" as local }';
    let clause = '';
    let tree = parser.parse(prefix + ';')!;
    try {
      expect(tree.rootNode.hasError).toBe(true);
      for (const nextClause of [' from "m"', '', ' from "m"']) {
        tree.edit(
          new Edit({
            startIndex: prefix.length,
            oldEndIndex: prefix.length + clause.length,
            newEndIndex: prefix.length + nextClause.length,
            startPosition: { row: 0, column: prefix.length },
            oldEndPosition: { row: 0, column: prefix.length + clause.length },
            newEndPosition: { row: 0, column: prefix.length + nextClause.length },
          })
        );
        const source = prefix + nextClause + ';';
        const previous = tree;
        tree = parser.parse(source, previous)!;
        previous.delete();
        const fresh = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(!nextClause);
          expect(tree.rootNode.toString()).toBe(fresh.rootNode.toString());
        } finally {
          fresh.delete();
        }
        clause = nextClause;
      }
    } finally {
      tree.delete();
      parser.delete();
    }
  }
});
