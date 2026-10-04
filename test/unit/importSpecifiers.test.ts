import { Language, Parser } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

test('matches TypeScript on contextual named-import modifiers', async () => {
  await Parser.init();
  for (const dialect of ['typescript', 'tsx']) {
    const parser = new Parser();
    parser.setLanguage(await Language.load(`tree-sitter-${dialect}.wasm`));
    try {
      for (const specifiers of [
        'typeof as',
        'typeof as as as',
        'typeof as, x',
        'typeof x',
        'typeof as x',
        'typeof as as',
        'type as',
        'type as as as',
      ]) {
        const source = `import { ${specifiers} } from 'x';`;
        const reference = ts.transpileModule(source, {
          reportDiagnostics: true,
          compilerOptions: { module: ts.ModuleKind.ESNext },
        });
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe((reference.diagnostics?.length ?? 0) > 0);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  }
});
