import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import { Language, Parser, Query } from '@willbooster/web-tree-sitter';

import treeSitterJson from '../../tree-sitter.json';

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
    const language = await Language.load(path.join(Root, `tree-sitter-${grammar.path}.wasm`));
    for (const kind of QueryKinds) {
      const source = queryPaths(grammar, kind)
        .map((file) => fs.readFileSync(path.join(Root, file), 'utf8'))
        .join('\n');
      expect(() => new Query(language, source), `${kind} queries`).not.toThrow();
    }
  });
}

// The package's tree-sitter.json can reference only files inside the package: a dependency's directory is not at a fixed
// path relative to it after an install.
test('publishes every query file that tree-sitter.json references', () => {
  const [pack] = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: Root, encoding: 'utf8' })
  ) as [{ files: { path: string }[] }];
  const published = new Set(pack.files.map((file) => file.path));
  for (const grammar of treeSitterJson.grammars) {
    for (const kind of QueryKinds) {
      for (const file of queryPaths(grammar, kind)) {
        expect(published, file).toContain(file);
      }
    }
  }
});

// queries/javascript/ copies the JavaScript grammar's queries, which this grammar extends.
test('keeps queries/javascript/ identical to the queries of @willbooster/tree-sitter-javascript', () => {
  for (const file of fs.readdirSync(path.join(Root, 'queries/javascript'))) {
    expect(
      fs.readFileSync(path.join(Root, 'queries/javascript', file), 'utf8'),
      `queries/javascript/${file} differs; run script/copy-javascript-queries`
    ).toBe(fs.readFileSync(path.join(JavaScriptQueries, file), 'utf8'));
  }
});
