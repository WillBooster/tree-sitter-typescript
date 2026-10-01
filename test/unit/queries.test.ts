import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import { Parser, Query } from '@willbooster/web-tree-sitter';

import treeSitterJson from '../../tree-sitter.json';

import { loadCurrentWasmBuild } from './wasmBuild';

const Root = path.join(import.meta.dirname, '../..');
const JavaScriptQueries = path.join(Root, 'node_modules/@willbooster/tree-sitter-javascript/queries');
const QueryKinds = ['highlights', 'injections', 'locals', 'tags'] as const;
await Parser.init();

const queryPaths = (grammar: (typeof treeSitterJson.grammars)[number], kind: (typeof QueryKinds)[number]): string[] =>
  [grammar[kind] ?? []].flat();

// Tools that read tree-sitter.json, such as the tree-sitter CLI, compile each kind of query of a grammar from its files
// concatenated, so a node type that a grammar change removes must fail here rather than in them.
for (const grammar of treeSitterJson.grammars) {
  test(`compiles the queries of ${grammar.name}`, async () => {
    const language = await loadCurrentWasmBuild(grammar.path);
    for (const kind of QueryKinds) {
      const source = queryPaths(grammar, kind)
        .map((file) => fs.readFileSync(path.join(Root, file), 'utf8'))
        .join('\n');
      expect(() => new Query(language, source), `${kind} queries`).not.toThrow();
    }
  });
}

// The packages' tree-sitter.json can reference only files inside the package: a dependency's directory is not at a
// fixed path relative to it after an install.
const listPublishedFiles = {
  npm: (): string[] => {
    const [pack] = JSON.parse(
      execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: Root, encoding: 'utf8' })
    ) as [{ files: { path: string }[] }];
    return pack.files.map((file) => file.path);
  },
  crate: (): string[] =>
    execFileSync('cargo', ['package', '--list', '--allow-dirty'], { cwd: Root, encoding: 'utf8' }).split('\n'),
};
for (const [packageKind, listFiles] of Object.entries(listPublishedFiles)) {
  // On a fresh runner, cargo first installs the toolchain that rust-toolchain.toml pins.
  const options = { timeout: 300_000 };
  test(`publishes every query file that tree-sitter.json references in the ${packageKind} package`, options, () => {
    const published = new Set(listFiles());
    expect(published).toContain('tree-sitter.json');
    for (const grammar of treeSitterJson.grammars) {
      for (const kind of QueryKinds) {
        for (const file of queryPaths(grammar, kind)) {
          expect(published, file).toContain(file);
        }
      }
    }
  });
}

// javascript/queries/ copies the JavaScript grammar's queries, which this grammar extends.
test('keeps javascript/queries/ identical to the queries of @willbooster/tree-sitter-javascript', () => {
  for (const file of fs.readdirSync(path.join(Root, 'javascript/queries'))) {
    expect(
      fs.readFileSync(path.join(Root, 'javascript/queries', file), 'utf8'),
      `javascript/queries/${file} differs; run script/copy-javascript-queries`
    ).toBe(fs.readFileSync(path.join(JavaScriptQueries, file), 'utf8'));
  }
});
