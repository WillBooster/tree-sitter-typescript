import { Edit, Parser, Query } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';
import { loadCurrentWasmBuild } from './wasmBuild';

await Parser.init();
for (const dialect of ['typescript', 'tsx']) {
  const language = await loadCurrentWasmBuild(dialect);
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
          expect(tree.rootNode.firstNamedChild?.childForFieldName('initializer')?.type).toBe('using_declaration');
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
    const query = new Query(language, '(export_statement declaration: (declaration) @declaration)');
    try {
      for (const declaration of [
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

  test(`${dialect} preserves default and heritage contexts through incremental prefix edits`, () => {
    const parser = new Parser().setLanguage(language);
    const prefix = 'export default ';
    try {
      for (const declaration of [
        'class Named<T> extends Base<T> {}',
        'class<T> extends Base<T> {}',
        'function<T>(x: T): T { return x; }',
        '@dec class<T> {}',
        'abstract class Named<T> extends Base<T> {}',
        'function named<T>(x: T): T { return x; }',
      ]) {
        const ordinary = `${declaration}\n(value);`;
        let tree = parser.parse(ordinary)!;
        try {
          for (const inserted of [true, false, true]) {
            tree.edit(
              new Edit({
                startIndex: 0,
                oldEndIndex: inserted ? 0 : prefix.length,
                newEndIndex: inserted ? prefix.length : 0,
                startPosition: { row: 0, column: 0 },
                oldEndPosition: { row: 0, column: inserted ? 0 : prefix.length },
                newEndPosition: { row: 0, column: inserted ? prefix.length : 0 },
              })
            );
            const source = (inserted ? prefix : '') + ordinary;
            const previous = tree;
            tree = parser.parse(source, previous)!;
            previous.delete();
            const fresh = parser.parse(source)!;
            try {
              expect(tree.rootNode.hasError, source).toBe(fresh.rootNode.hasError);
              if (inserted) {
                expect(tree.rootNode.hasError, source).toBe(false);
                expect(tree.rootNode.firstNamedChild?.type).toBe('export_statement');
                expect(tree.rootNode.firstNamedChild?.childForFieldName('declaration'), source).toBeTruthy();
              }
              expect(tree.rootNode.toString(), source).toBe(fresh.rootNode.toString());
              if (inserted || declaration.includes('Named') || declaration.includes('named')) {
                expect(tree.rootNode.lastNamedChild?.text, source).toBe('(value);');
              }
              expect(
                tree.rootNode.descendantsOfType('type_arguments').map((n) => n.text),
                source
              ).toEqual(fresh.rootNode.descendantsOfType('type_arguments').map((n) => n.text));
            } finally {
              fresh.delete();
            }
          }
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });

  test(`${dialect} restores regex boundaries after flag edits`, () => {
    const parser = new Parser().setLanguage(language);
    let flags = 'g';
    let tree = parser.parse('/x/g/* boundary */instanceof value;')!;
    try {
      for (const nextFlags of ['', 'gi', '', 'g']) {
        tree.edit(
          new Edit({
            startIndex: 3,
            oldEndIndex: 3 + flags.length,
            newEndIndex: 3 + nextFlags.length,
            startPosition: { row: 0, column: 3 },
            oldEndPosition: { row: 0, column: 3 + flags.length },
            newEndPosition: { row: 0, column: 3 + nextFlags.length },
          })
        );
        const source = `/x/${nextFlags}/* boundary */instanceof value;`;
        const previous = tree;
        tree = parser.parse(source, previous)!;
        previous.delete();
        const fresh = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(tree.rootNode.toString(), source).toBe(fresh.rootNode.toString());
          expect(tree.rootNode.descendantsOfType('regex')[0]?.text, source).toBe(`/x/${nextFlags}`);
          expect(
            tree.rootNode.descendantsOfType('comment').map((n) => n.text),
            source
          ).toEqual(['/* boundary */']);
          expect(
            tree.rootNode.descendantsOfType('binary_expression')[0]?.childForFieldName('operator')?.text,
            source
          ).toBe('instanceof');
        } finally {
          fresh.delete();
        }
        flags = nextFlags;
      }
    } finally {
      tree.delete();
      parser.delete();
    }
  });
}
