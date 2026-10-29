import { Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

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
