import { Parser } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { loadCurrentWasmBuild } from './wasmBuild.js';

test('matches TypeScript on contextual named-import modifiers', async () => {
  await Parser.init();
  for (const dialect of ['typescript', 'tsx']) {
    const parser = new Parser();
    parser.setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const specifiers of [
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
      ]) {
        const source = `import { ${specifiers} } from 'x';`;
        const reference = ts.transpileModule(source, {
          reportDiagnostics: true,
          compilerOptions: { module: ts.ModuleKind.ESNext },
        });
        const tree = parser.parse(source)!;
        try {
          const invalid = (reference.diagnostics?.length ?? 0) > 0;
          expect(tree.rootNode.hasError, source).toBe(invalid);
          if (!invalid) {
            const ast = ts.createSourceFile('imports.ts', source, ts.ScriptTarget.Latest, true);
            const expected = ast.statements.filter(ts.isImportDeclaration).flatMap((statement) => {
              const bindings = statement.importClause?.namedBindings;
              return bindings && ts.isNamedImports(bindings)
                ? bindings.elements.map((specifier) => ({
                    name: (specifier.propertyName ?? specifier.name).getText(ast),
                    alias: specifier.propertyName ? specifier.name.getText(ast) : undefined,
                    typeOnly: specifier.isTypeOnly,
                  }))
                : [];
            });
            expect(
              tree.rootNode.descendantsOfType('import_specifier').map((specifier) => ({
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
});

test('matches TypeScript on named-export modifiers and identifier fields', async () => {
  await Parser.init();
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
  for (const dialect of ['typescript', 'tsx']) {
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const source of sources) {
        const { ast, invalid } = exportReference(source, dialect === 'tsx');
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(invalid);
          if (!invalid) {
            const expected = ast.statements.filter(ts.isExportDeclaration).flatMap((statement) => {
              const clause = statement.exportClause;
              return clause && ts.isNamedExports(clause)
                ? clause.elements.map((specifier) => ({
                    name: (specifier.propertyName ?? specifier.name).getText(ast),
                    alias: specifier.propertyName ? specifier.name.getText(ast) : undefined,
                    typeOnly: specifier.isTypeOnly,
                  }))
                : [];
            });
            expect(
              tree.rootNode.descendantsOfType('export_specifier').map((specifier) => ({
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
});

function exportReference(source: string, tsx: boolean): { ast: ts.SourceFile; invalid: boolean } {
  const file = tsx ? '/exports.tsx' : '/exports.ts';
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
