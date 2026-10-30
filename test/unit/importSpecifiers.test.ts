import { Parser, Query } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { loadCurrentWasmBuild } from './wasmBuild.js';

test('matches TypeScript on contextual named-import modifiers', async () => {
  const specifiers = [
    'typeof as',
    'typeof as as as',
    'typeof as, x',
    'typeof x',
    'typeof as x',
    'typeof as as',
    'type as',
    'type as as',
    'type as as as',
    'as as type',
    'type value',
    'type value as local',
    '"remote" as local',
    'type "remote" as local',
    'type as, value as local',
    'type as as as, "remote" as local',
  ];
  await expectSpecifiers(
    specifiers.map((specifier) => `import { ${specifier} } from 'x';`),
    'import'
  );
});

test('matches TypeScript on named-export modifiers and identifier fields', async () => {
  const specifiers = [
    'typeof x',
    'typeof x as y',
    'typeof as',
    'typeof as as as',
    'type x',
    'type x as y',
    'type as',
    'type as as',
    'type as as as',
    'as as type',
  ];
  const sources = specifiers.flatMap((specifier) =>
    ['', ' from "m"'].map((suffix) => `export { ${specifier} }${suffix};`)
  );
  sources.push(
    'export { typeof } from "m";',
    'export { typeof as x } from "m";',
    'export { "remote" as local } from "m";',
    'export { type "remote" as local } from "m";'
  );
  await expectSpecifiers(sources, 'export');
});

test('distinguishes binding imports from side-effect imports', async () => {
  const source = `
import value from "default";
import * as namespace from "namespace";
import { remote as local } from "named";
import valueAndNames, { other } from "combined";
import type { Type } from "types";
import required = require("dependency");
import "side-effect";
`;
  const reference = ts.createSourceFile('imports.ts', source, ts.ScriptTarget.Latest, true);
  const imports = reference.statements.filter(ts.isImportDeclaration);
  const expectedBindings = imports.flatMap((statement) =>
    statement.importClause ? [statement.importClause.getText(reference).replace(/^type /, '')] : []
  );
  const expectedRequireBindings = reference.statements
    .filter(ts.isImportEqualsDeclaration)
    .map((statement) => source.slice(statement.name.getStart(reference), statement.moduleReference.end));
  const expectedSideEffects = imports
    .filter((statement) => !statement.importClause)
    .map((statement) => statement.getText(reference));
  await Parser.init();
  for (const dialect of ['typescript', 'tsx']) {
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser().setLanguage(language);
    const query = new Query(
      language,
      `
      (import_statement import_clause: (import_clause) @bindings)
      (import_statement import_clause: (import_require_clause) @requireBindings)
      (import_statement !import_clause) @sideEffect
    `
    );
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      const captures = query.captures(tree.rootNode);
      expect(captures.filter(({ name }) => name === 'bindings').map(({ node }) => node.text)).toEqual(expectedBindings);
      expect(captures.filter(({ name }) => name === 'requireBindings').map(({ node }) => node.text)).toEqual(
        expectedRequireBindings
      );
      expect(captures.filter(({ name }) => name === 'sideEffect').map(({ node }) => node.text)).toEqual(
        expectedSideEffects
      );
    } finally {
      tree.delete();
      query.delete();
      parser.delete();
    }
  }
});

async function expectSpecifiers(sources: string[], kind: 'import' | 'export'): Promise<void> {
  await Parser.init();
  for (const dialect of ['typescript', 'tsx']) {
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const source of sources) {
        const { ast, invalid } = compilerReference(source, dialect === 'tsx');
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(invalid);
          if (!invalid) {
            const expected = ast.statements.flatMap((statement) => {
              const clause = ts.isImportDeclaration(statement)
                ? statement.importClause?.namedBindings
                : ts.isExportDeclaration(statement)
                  ? statement.exportClause
                  : undefined;
              return clause && (ts.isNamedImports(clause) || ts.isNamedExports(clause))
                ? clause.elements.map((specifier) => ({
                    name: (specifier.propertyName ?? specifier.name).getText(ast),
                    alias: specifier.propertyName ? specifier.name.getText(ast) : undefined,
                    typeOnly: specifier.isTypeOnly,
                  }))
                : [];
            });
            expect(
              tree.rootNode.descendantsOfType(`${kind}_specifier`).map((specifier) => ({
                name: specifier.childForFieldName('name')?.text,
                alias: specifier.childForFieldName('alias')?.text,
                typeOnly: specifier.children.some((child) => !child.isNamed && child.type === 'type'),
              })),
              source
            ).toEqual(expected);
          }
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  }
}

function compilerReference(source: string, tsx: boolean): { ast: ts.SourceFile; invalid: boolean } {
  const file = tsx ? '/specifiers.tsx' : '/specifiers.ts';
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const options: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    types: [],
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.Preserve,
  };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === file ? ast : undefined);
  const program = ts.createProgram([file], options, host);
  const diagnostics = [...program.getSyntacticDiagnostics(ast), ...program.getSemanticDiagnostics(ast)];
  return { ast, invalid: diagnostics.some(({ code }) => code >= 1000 && code < 2000) };
}
