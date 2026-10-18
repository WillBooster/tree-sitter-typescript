import { expect, test } from 'vitest';

import { Edit, Parser, Query } from '@willbooster/web-tree-sitter';

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

for (const dialect of ['typescript', 'tsx']) {
  test(`keeps keyword-named heritage generics separate from ordinary types in ${dialect}`, async () => {
    const parser = new Parser();
    parser.setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const name of [
        'any',
        'number',
        'boolean',
        'string',
        'symbol',
        'unknown',
        'never',
        'object',
        'this',
        'import',
        'true',
        'false',
        'null',
        'undefined',
        'keyof',
        'readonly',
        'unique',
        'infer',
        'abstract',
        'as',
        'satisfies',
      ]) {
        for (const gap of ['', '\n', '/*\n*/']) {
          const source = `class C implements ${name}${gap}<Box<string>>, Other<number> { value: number; }`;
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(false);
            expect(
              tree.rootNode.descendantsOfType('generic_type').map((node) => node.childForFieldName('name')?.text)
            ).toEqual([name, 'Box', 'Other']);
            expect(
              tree.rootNode
                .descendantsOfType('public_field_definition')
                .map((node) => node.childForFieldName('name')?.text)
            ).toEqual(['value']);
          } finally {
            tree.delete();
          }
        }
      }
      const original = 'class C implements number<Box<string>> {}';
      const tree = parser.parse(original)!;
      const index = original.indexOf('<');
      tree.edit(
        new Edit({
          startIndex: index,
          oldEndIndex: index,
          newEndIndex: index + 7,
          startPosition: { row: 0, column: index },
          oldEndPosition: { row: 0, column: index },
          newEndPosition: { row: 0, column: index + 7 },
        })
      );
      const editedSource = `${original.slice(0, index)}/* c */${original.slice(index)}`;
      const edited = parser.parse(editedSource, tree)!;
      const fresh = parser.parse(editedSource)!;
      try {
        expect(edited.rootNode.hasError).toBe(false);
        expect(edited.rootNode.toString()).toBe(fresh.rootNode.toString());
        expect(edited.rootNode.descendantsOfType('generic_type')[0]?.childForFieldName('name')?.text).toBe('number');
      } finally {
        tree.delete();
        edited.delete();
        fresh.delete();
      }
      for (const name of ['new', 'typeof', 'void']) {
        const source = `class C implements ${name}<B> {}`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(true);
        } finally {
          tree.delete();
        }
      }
      for (const name of [
        'any',
        'number',
        'boolean',
        'string',
        'symbol',
        'unknown',
        'never',
        'object',
        'this',
        'import',
        'true',
        'false',
        'null',
        'undefined',
        'keyof',
        'readonly',
        'unique',
        'infer',
      ]) {
        for (const type of [`A | ${name}<B>`, `A[] | ${name}<B>`, `{p: (x:${name}<B>)=>X}`]) {
          const source = `class C implements ${type} {}`;
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(true);
          } finally {
            tree.delete();
          }
        }
      }
      for (const source of [
        'class C implements number;\ntype R = number<B>;',
        'class C implements number\ntype R = number<B>;',
        'class C implements number;\nconst x: number<B> = 1;',
      ]) {
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(true);
          expect(tree.rootNode.descendantsOfType('generic_type'), source).toHaveLength(0);
        } finally {
          tree.delete();
        }
      }
      const direct = 'class C implements number<B> {}';
      const nameIndex = direct.indexOf('number');
      let incremental = parser.parse(direct)!;
      for (const prefix of ['A | ', '{p: (x:', '']) {
        const nextSource = `${direct.slice(0, nameIndex)}${prefix}number<B>${prefix === '{p: (x:' ? ')=>X}' : ''} {}`;
        const previousSource = incremental.rootNode.text;
        incremental.edit(
          new Edit({
            startIndex: nameIndex,
            oldEndIndex: previousSource.length,
            newEndIndex: nextSource.length,
            startPosition: { row: 0, column: nameIndex },
            oldEndPosition: { row: 0, column: previousSource.length },
            newEndPosition: { row: 0, column: nextSource.length },
          })
        );
        const next = parser.parse(nextSource, incremental)!;
        const fresh = parser.parse(nextSource)!;
        try {
          expect(next.rootNode.hasError, nextSource).toBe(prefix !== '');
          expect(next.rootNode.toString()).toBe(fresh.rootNode.toString());
        } finally {
          fresh.delete();
          incremental.delete();
        }
        incremental = next;
      }
      incremental.delete();
      for (const source of [
        'type R = number<B>;',
        'class C implements Box<number<B>> {}',
        'class C implements number<B> {} type R = number<B>;',
      ]) {
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(true);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });
}
