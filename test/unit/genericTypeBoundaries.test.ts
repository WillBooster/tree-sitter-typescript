import { expect, test } from 'vitest';

import { Parser, Query } from '@willbooster/web-tree-sitter';

import { loadCurrentWasmBuild } from './wasmBuild';

await Parser.init();

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves generic name ranges and heritage type queries in ${dialect}`, async () => {
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser();
    parser.setLanguage(language);
    const query = new Query(language, '(implements_clause (type) @type) (implements_clause (primary_type) @primary)');
    try {
      for (const trivia of [' ', ' /* leading */ ', '\n/* leading */\n']) {
        const tree = parser.parse(`type A =${trivia}Foo<string>;`)!;
        try {
          expect(tree.rootNode.hasError).toBe(false);
          const generic = tree.rootNode.descendantsOfType('generic_type')[0]!;
          expect(generic.text).toBe('Foo<string>');
          expect(generic.childForFieldName('name')?.text).toBe('Foo');
          expect(generic.namedChildren.some((node) => node.type === 'comment')).toBe(false);
        } finally {
          tree.delete();
        }
      }
      for (const name of ['Foo', 'ns.Foo']) {
        for (const parameters of [
          'T',
          'T, U',
          'T extends object',
          'T = string',
          'const T',
          'T extends { fn: <U>() => U; value: ">" }',
          'T extends `x${string}`',
          'T extends `x${`y${string}`}`',
          '/* before */ T /* after */',
        ]) {
          const argument = `<${parameters}>() => T`;
          const tree = parser.parse(`type R = ${name}<${argument}>;`)!;
          try {
            expect(tree.rootNode.hasError, tree.rootNode.text).toBe(false);
            const generic = tree.rootNode.descendantsOfType('generic_type')[0]!;
            expect(generic.childForFieldName('name')?.text).toBe(name);
            const args = generic.childForFieldName('type_arguments')!;
            expect(
              args.namedChildren.filter((node) => node.type !== 'comment').map((node) => [node.type, node.text])
            ).toEqual([['function_type', argument]]);
          } finally {
            tree.delete();
          }
        }
      }
      for (const source of [
        'f(a as T << b, c);',
        'const s = a as T << b > c;',
        'const s = a satisfies T << b === c;',
        'let v = x as Y << z, w = 1;',
      ]) {
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(tree.rootNode.descendantsOfType('generic_type')).toHaveLength(0);
          expect(
            tree.rootNode
              .descendantsOfType('binary_expression')
              .some((node) => node.childForFieldName('operator')?.text === '<<')
          ).toBe(true);
        } finally {
          tree.delete();
        }
      }
      for (const gap of [' ', '\n', '\r\n', '\r', '\u2028', '\u2029', '/*\n*/', '// line\n']) {
        const source = `class C implements Foo${gap}<string>, ns.Bar${gap}<number> {}`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          for (const kind of ['type', 'primary'])
            expect(
              query
                .captures(tree.rootNode)
                .filter(({ name }) => name === kind)
                .map(({ node }) => node.text)
            ).toEqual([`Foo${gap}<string>`, `ns.Bar${gap}<number>`]);
        } finally {
          tree.delete();
        }
      }
    } finally {
      query.delete();
      parser.delete();
    }
  });
}
