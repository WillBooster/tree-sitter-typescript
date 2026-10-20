import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { Edit, Parser, Query } from '@willbooster/web-tree-sitter';

import { compareEditedTree, position } from '../helpers/treeEdit';
import { loadCurrentWasmBuild } from './wasmBuild';

const heritageKeywords = [
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
];

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
    const language = await loadCurrentWasmBuild(dialect);
    const query = new Query(language, '(implements_clause (type) @type) (implements_clause (primary_type) @primary)');
    const parser = new Parser();
    parser.setLanguage(language);
    try {
      for (const name of [...heritageKeywords, 'abstract', 'as', 'satisfies']) {
        for (const gap of ['', '\n', '/*\n*/']) {
          for (const prefix of ['', 'A, ']) {
            const source = `class C implements ${prefix}${name}${gap}<Box<string>>, Other<number> { value: number; }`;
            const tree = parser.parse(source)!;
            try {
              expect(tree.rootNode.hasError, source).toBe(false);
              for (const kind of ['type', 'primary']) {
                expect(
                  query
                    .captures(tree.rootNode)
                    .filter(({ name }) => name === kind)
                    .map(({ node }) => node.text)
                ).toEqual([...(prefix ? ['A'] : []), `${name}${gap}<Box<string>>`, 'Other<number>']);
              }
              expect(
                tree.rootNode.descendantsOfType('generic_type').map((node) => node.childForFieldName('name')?.text)
              ).toEqual([name, 'Box', 'Other']);
              for (const generic of tree.rootNode.descendantsOfType('generic_type')) {
                expect(generic.childForFieldName('name')?.childCount).toBe(0);
              }
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
      }
      for (const name of ['number', 'readonly', 'keyof']) {
        for (const argument of ['(<T>() => T)', 'T extends U ? X : Y', '`x${string}`', '{ [K in keyof T]: T[K] }']) {
          for (const prefix of ['', 'string, ']) {
            for (const trailing of ['', ',']) {
              const source = `class C implements ${name}<${prefix}${argument}${trailing}> {}`;
              const tree = parser.parse(source)!;
              try {
                expect(tree.rootNode.hasError, source).toBe(false);
                const generic = tree.rootNode.descendantsOfType('generic_type')[0]!;
                expect(generic.childForFieldName('name')?.text).toBe(name);
                expect(generic.childForFieldName('type_arguments')?.namedChildren.map((node) => node.text)).toEqual([
                  ...(prefix ? ['string'] : []),
                  argument,
                ]);
              } finally {
                tree.delete();
              }
            }
          }
        }
      }
      const original = 'class C implements number<Box<string>> {}';
      const tree = parser.parse(original)!;
      const index = original.indexOf('<');
      const editedSource = `${original.slice(0, index)}/* c */${original.slice(index)}`;
      try {
        const edited = compareEditedTree(
          parser,
          tree,
          editedSource,
          new Edit({
            startIndex: index,
            oldEndIndex: index,
            newEndIndex: index + 7,
            startPosition: { row: 0, column: index },
            oldEndPosition: { row: 0, column: index },
            newEndPosition: { row: 0, column: index + 7 },
          }),
          (next) => {
            expect(next.rootNode.descendantsOfType('generic_type')[0]?.childForFieldName('name')?.text).toBe('number');
          }
        );
        edited.delete();
      } finally {
        tree.delete();
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
      for (const name of heritageKeywords) {
        for (const type of [
          `A | ${name}<B>`,
          `A[] | ${name}<B>`,
          `{p: (x:${name}<B>)=>X}`,
          `${name}<Box\n<string>>`,
          `${name}<ns.Box\n<string>>`,
          `${name}<string, Box\n<string>>`,
          `${name}<{ value: Box/*\n*/<string> }>`,
          `${name}<(value: Box\n<string>) => Result>`,
          ...['[]', ' | A', ' & A', "['x']", ' extends A ? X : Y'].map((suffix) => `${name}<B>${suffix}`),
        ]) {
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
          expect(
            tree.rootNode.descendantsOfType('generic_type').filter((node) => !node.hasError),
            source
          ).toHaveLength(0);
        } finally {
          tree.delete();
        }
      }
      for (const source of [
        'class C implements readonly<\nlet x = 1;\nconst sentinel = 1;',
        'class C implements keyof<B>\nconst x: number<B> = 1;\nconst sentinel = 1;',
      ]) {
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(true);
          expect(
            tree.rootNode.descendantsOfType('lexical_declaration').some((node) => node.text === 'const sentinel = 1;'),
            source
          ).toBe(true);
        } finally {
          tree.delete();
        }
      }
      const manyArguments = `class C implements number<${Array.from({ length: 128 }, () => 'Box<string>').join(',')}> {}`;
      const manyTree = parser.parse(manyArguments)!;
      try {
        expect(manyTree.rootNode.hasError).toBe(false);
        const generic = manyTree.rootNode.descendantsOfType('generic_type')[0]!;
        expect(generic.childForFieldName('type_arguments')?.namedChildCount).toBe(128);
      } finally {
        manyTree.delete();
      }
      const direct = 'class C implements number<B> {}';
      const nameIndex = direct.indexOf('number');
      let incremental = parser.parse(direct)!;
      try {
        for (const entry of [
          'A | number<B>',
          '{p: (x:number<B>)=>X}',
          'number<B>[]',
          'number<B> | A',
          'number<Box\n<string>>',
          'number<B>',
        ]) {
          const nextSource = `${direct.slice(0, nameIndex)}${entry} {}`;
          const previousSource = incremental.rootNode.text;
          const next = compareEditedTree(
            parser,
            incremental,
            nextSource,
            new Edit({
              startIndex: nameIndex,
              oldEndIndex: previousSource.length,
              newEndIndex: nextSource.length,
              startPosition: { row: 0, column: nameIndex },
              oldEndPosition: position(previousSource, previousSource.length),
              newEndPosition: position(nextSource, nextSource.length),
            }),
            (edited) => expect(edited.rootNode.hasError, nextSource).toBe(entry !== 'number<B>'),
            true
          );
          incremental.delete();
          incremental = next;
        }
      } finally {
        incremental.delete();
      }
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
      query.delete();
      parser.delete();
    }
  });
}

for (const dialect of ['typescript', 'tsx']) {
  test(`matches compiler-valid heritage arguments and incremental spacing in ${dialect}`, async () => {
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const name of heritageKeywords) {
        for (const prefix of ['', 'A, ']) {
          for (const args of [
            '< <T>()=>T>',
            '</*c*/<T>()=>T>',
            '<\n<T>()=>T>',
            '<(<T>()=>T)>',
            '<A,<T>()=>T>',
            '<Box<<T>()=>T>>',
          ]) {
            const source = `class C implements ${prefix}${name}${args} {}`;
            const diagnostics =
              ts.transpileModule(source, {
                reportDiagnostics: true,
                compilerOptions: { target: ts.ScriptTarget.ESNext },
              }).diagnostics ?? [];
            const tree = parser.parse(source)!;
            try {
              expect(
                diagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error),
                source
              ).toEqual([]);
              expect(tree.rootNode.hasError, source).toBe(false);
              const generic = tree.rootNode.descendantsOfType('generic_type')[0]!;
              expect(generic.childForFieldName('name')?.text).toBe(name);
              expect(generic.childForFieldName('type_arguments')?.text).toBe(args);
            } finally {
              tree.delete();
            }
          }
        }
      }
      let source = 'class C implements number< <T>()=>T> {}';
      let tree = parser.parse(source)!;
      const index = source.indexOf('<') + 1;
      let oldLength = 1;
      try {
        for (const separator of ['/* gap */', ' ']) {
          const nextSource = source.slice(0, index) + separator + source.slice(index + oldLength);
          const incremental = compareEditedTree(
            parser,
            tree,
            nextSource,
            new Edit({
              startIndex: index,
              oldEndIndex: index + oldLength,
              newEndIndex: index + separator.length,
              startPosition: { row: 0, column: index },
              oldEndPosition: { row: 0, column: index + oldLength },
              newEndPosition: { row: 0, column: index + separator.length },
            }),
            () => {}
          );
          tree.delete();
          tree = incremental;
          source = nextSource;
          oldLength = separator.length;
        }
      } finally {
        tree.delete();
      }
    } finally {
      parser.delete();
    }
  });
}

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves declarations while editing a keyword heritage closing angle in ${dialect}`, async () => {
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const name of ['number', 'import', 'readonly', 'keyof']) {
        for (const prefix of ['', 'A, ']) {
          for (const argument of ['B', 'Box<B>', '{ value: B }', '(value: B) => C']) {
            const valid = `class C implements ${prefix}${name}<${argument}> {}\nconst sentinel = 1;\nfunction after() {}`;
            const angle = valid.lastIndexOf('>');
            let tree = parser.parse(valid)!;
            try {
              for (const remove of [true, false]) {
                const source = remove ? valid.slice(0, angle) + valid.slice(angle + 1) : valid;
                const oldEnd = angle + (remove ? 1 : 0);
                const newEnd = angle + (remove ? 0 : 1);
                const next = compareEditedTree(
                  parser,
                  tree,
                  source,
                  new Edit({
                    startIndex: angle,
                    oldEndIndex: oldEnd,
                    newEndIndex: newEnd,
                    startPosition: { row: 0, column: angle },
                    oldEndPosition: { row: 0, column: oldEnd },
                    newEndPosition: { row: 0, column: newEnd },
                  }),
                  (edited) => {
                    expect(edited.rootNode.hasError, source).toBe(remove);
                    expect(
                      edited.rootNode.namedChildren.map((node) => node.type),
                      source
                    ).toEqual(['class_declaration', 'lexical_declaration', 'function_declaration']);
                  },
                  true
                );
                tree.delete();
                tree = next;
              }
            } finally {
              tree.delete();
            }
          }
        }
      }
    } finally {
      parser.delete();
    }
  });
}
