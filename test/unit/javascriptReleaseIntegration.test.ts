import { Parser, Query } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { loadCurrentWasmBuild } from './wasmBuild';

await Parser.init();
for (const dialect of ['typescript', 'tsx']) {
  const language = await loadCurrentWasmBuild(dialect);
  test(`${dialect} rejects default variable and resource declarations`, () => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const declaration of [
        'let value = 42;',
        'const value = 42;',
        'var value = 42;',
        'using value = create();',
        'await using value = create();',
        'type Value = string;',
        'enum Value { One }',
      ]) {
        for (const separator of [' ', '/* comment */', '\n']) {
          const source = `export default${separator}${declaration}`;
          const reference = ts.transpileModule(source, { reportDiagnostics: true });
          expect(reference.diagnostics?.length, source).toBeGreaterThan(0);
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(true);
          } finally {
            tree.delete();
          }
        }
        const named = parser.parse(`export ${declaration}`)!;
        try {
          expect(named.rootNode.hasError, declaration).toBe(false);
        } finally {
          named.delete();
        }
      }
      for (const value of ['let', 'using', 'abstract', 'async', 'value', '(value = 42)']) {
        const tree = parser.parse(`export default ${value};`)!;
        try {
          expect(tree.rootNode.hasError, value).toBe(false);
          expect(tree.rootNode.firstNamedChild?.childForFieldName('value')?.text).toBe(value);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });

  test(`${dialect} rejects let as a typed or untyped lexical binding`, () => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const [source, valid] of [
        ['let let = 1;', false],
        ['const let: T = 1;', false],
        [String.raw`let let!: T;`, false],
        ['let value: T = 1, let = 2;', false],
        ['for (const let of values) {}', false],
        ['async function f() { await using let: T = create(); }', false],
        ['var let: T = 1;', true],
        ['let value: T = let, of: T = 1;', true],
        ['for (const as: T = 1; ; ) {}', true],
        ['using satisfies: T = create();', true],
      ] as const) {
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(!valid);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });

  test(`${dialect} preserves typed resource bindings and regex statement boundaries`, () => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const source of [
        'for(using of: T = x;;){}',
        'for(using of = x;;){}',
        'for(using\nof: T = x;;){}',
        'for(using/*\n*/of: T = x;;){}',
      ]) {
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(
            tree.rootNode.firstNamedChild?.childForFieldName('header')?.childForFieldName('initializer')?.type
          ).toBe('using_declaration');
        } finally {
          tree.delete();
        }
      }
      for (const declaration of ['type X = T', 'let x: T', 'declare function f(): T']) {
        const source = `${declaration}/*\nc*//x/.test(y);`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(tree.rootNode.lastNamedChild?.type, source).toBe('expression_statement');
          expect(tree.rootNode.lastNamedChild?.text, source).toBe('/x/.test(y);');
          expect(tree.rootNode.descendantsOfType('regex')).toHaveLength(1);
        } finally {
          tree.delete();
        }
      }
      for (const source of ['const x = a/*\nc*//b/g;', 'x as T/*\nc*//b/g;', 'for (using of xs) {}']) {
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(tree.rootNode.descendantsOfType('regex'), source).toHaveLength(0);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });

  test(`${dialect} distinguishes contextual resource names from expression initializers`, () => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const boundary of [' ', '\n', '/* comment */', '/*\n*/', '// comment\n']) {
        const source = `for(using${boundary}? a : b;;){}`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(tree.rootNode.descendantsOfType('ternary_expression')).toHaveLength(1);
          expect(
            tree.rootNode.descendantsOfType('comment').map((n) => n.text),
            source
          ).toEqual(boundary.startsWith('/') ? [boundary.trimEnd()] : []);
          expect(tree.rootNode.descendantsOfType('using_declaration')).toHaveLength(0);
        } finally {
          tree.delete();
        }
      }
      for (const [source, hasError] of [
        ['for (using of of items) {}', true],
        ['for (await using of of items) {}', false],
      ] as const) {
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(hasError);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });

  test(`${dialect} ends await-using expressions when a newline rejects a resource binding`, () => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const boundary of ['\n', '// boundary\n', '/*\n*/']) {
        for (const name of ['x', 'of']) {
          const source = `async function f() { await using${boundary}${name} = 1; }`;
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(false);
            expect(tree.rootNode.descendantsOfType('await_expression').map((n) => n.text)).toEqual(['await using']);
            expect(tree.rootNode.descendantsOfType('assignment_expression').map((n) => n.text)).toEqual([
              `${name} = 1`,
            ]);
            expect(tree.rootNode.descendantsOfType('using_declaration')).toHaveLength(0);
          } finally {
            tree.delete();
          }
        }
      }
    } finally {
      parser.delete();
    }
  });

  test(`${dialect} keeps typed default declarations separate from following expressions`, () => {
    const parser = new Parser().setLanguage(language);
    const query = new Query(language, '(export_statement declaration: (_) @declaration)');
    try {
      for (const declaration of [
        'interface Shape<T> { value: T }',
        'function signature<T>(x: T): T;',
        'function<T>(x: T): T { return x; }',
        'async function<T>(x: T) { return x; }',
        'function*<T>(x: T) { yield x; }',
        'class<T> {}',
        'abstract class<T> {}',
        '@dec class<T> {}',
      ]) {
        for (const suffix of ['(value);', '[value];', '`tag`;']) {
          const source = `export default ${declaration} /* boundary */\n${suffix}`;
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(false);
            expect(
              query.captures(tree.rootNode).map(({ node }) => node.text),
              source
            ).toEqual([declaration]);
            expect(tree.rootNode.lastNamedChild?.text, source).toBe(suffix);
            expect(tree.rootNode.lastNamedChild?.type, source).toBe('expression_statement');
          } finally {
            tree.delete();
          }
        }
      }
    } finally {
      query.delete();
      parser.delete();
    }
  });

  test(`${dialect} preserves default and heritage contexts with and without an export default prefix`, () => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const declaration of [
        'interface Named<T> { value: T }',
        'class Named<T> extends Base<T> {}',
        'class<T> extends Base<T> {}',
        'function<T>(x: T): T { return x; }',
        '@dec class<T> {}',
        'abstract class Named<T> extends Base<T> {}',
        'function named<T>(x: T): T { return x; }',
      ]) {
        for (const inserted of [false, true]) {
          const source = `${inserted ? 'export default ' : ''}${declaration}\n(value);`;
          const tree = parser.parse(source)!;
          try {
            if (inserted) {
              expect(tree.rootNode.hasError, source).toBe(false);
              expect(tree.rootNode.firstNamedChild?.type).toBe('export_statement');
              expect(tree.rootNode.firstNamedChild?.childForFieldName('declaration'), source).toBeTruthy();
            }
            if (inserted || declaration.includes('Named') || declaration.includes('named')) {
              expect(tree.rootNode.lastNamedChild?.text, source).toBe('(value);');
            }
          } finally {
            tree.delete();
          }
        }
      }
    } finally {
      parser.delete();
    }
  });

  test(`${dialect} keeps regex boundaries across flags`, () => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const flags of ['g', '', 'gi']) {
        const source = `/x/${flags}/* boundary */instanceof value;`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(tree.rootNode.descendantsOfType('regex')[0]?.text, source).toBe(`/x/${flags}`);
          expect(
            tree.rootNode.descendantsOfType('comment').map((n) => n.text),
            source
          ).toEqual(['/* boundary */']);
          expect(
            tree.rootNode.descendantsOfType('binary_expression')[0]?.childForFieldName('operator')?.text,
            source
          ).toBe('instanceof');
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });
}
