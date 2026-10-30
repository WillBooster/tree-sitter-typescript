import { Parser, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

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
  test(`preserves generic name ranges and heritage types in ${dialect}`, async () => {
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser();
    parser.setLanguage(language);
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
          expect(tree.rootNode.hasError, source).toBe(true);
        } finally {
          tree.delete();
        }
      }
      for (const source of [
        'f((a as T) << b, c);',
        'const s = (a as T) << b > c;',
        'const s = (a satisfies T) << b === c;',
        'let v = (x as Y) << z, w = 1;',
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
          expect(implementedTypes(tree)).toEqual([`Foo${gap}<string>`, `ns.Bar${gap}<number>`]);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });
}

for (const dialect of ['typescript', 'tsx']) {
  test(`keeps keyword-named heritage generics separate from ordinary types in ${dialect}`, async () => {
    const language = await loadCurrentWasmBuild(dialect);
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
              expect(implementedTypes(tree)).toEqual([
                ...(prefix ? ['A'] : []),
                `${name}${gap}<Box<string>>`,
                'Other<number>',
              ]);
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
      const commented = 'class C implements number/* c */<Box<string>> {}';
      const commentedTree = parser.parse(commented)!;
      try {
        expect(commentedTree.rootNode.hasError).toBe(false);
        expect(commentedTree.rootNode.descendantsOfType('generic_type')[0]?.childForFieldName('name')?.text).toBe(
          'number'
        );
      } finally {
        commentedTree.delete();
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
      for (const entry of [
        'A | number<B>',
        '{p: (x:number<B>)=>X}',
        'number<B>[]',
        'number<B> | A',
        'number<Box\n<string>>',
        'number<B>',
      ]) {
        const source = `class C implements ${entry} {}`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(entry !== 'number<B>');
        } finally {
          tree.delete();
        }
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
      parser.delete();
    }
  });
}

for (const dialect of ['typescript', 'tsx']) {
  test(`matches compiler-valid heritage arguments and comment spacing in ${dialect}`, async () => {
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
      for (const separator of ['/* gap */', ' ']) {
        const source = `class C implements number<${separator}<T>()=>T> {}`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });
}

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves declarations with and without a keyword heritage closing angle in ${dialect}`, async () => {
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const name of ['number', 'import', 'readonly', 'keyof']) {
        for (const prefix of ['', 'A, ']) {
          for (const argument of ['B', 'Box<B>', '{ value: B }', '(value: B) => C']) {
            const valid = `class C implements ${prefix}${name}<${argument}> {}\nconst sentinel = 1;\nfunction after() {}`;
            const angle = valid.lastIndexOf('>');
            for (const source of [valid, valid.slice(0, angle) + valid.slice(angle + 1)]) {
              const tree = parser.parse(source)!;
              try {
                expect(tree.rootNode.hasError, source).toBe(source !== valid);
                expect(
                  tree.rootNode.namedChildren.map((node) => node.type),
                  source
                ).toEqual(['class_declaration', 'lexical_declaration', 'function_declaration']);
              } finally {
                tree.delete();
              }
            }
          }
        }
      }
    } finally {
      parser.delete();
    }
  });
}

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves empty generic argument recovery in ${dialect}`, async () => {
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const template of [
        'let value: Box<ARGUMENT>;',
        'let value: ns.Box<ARGUMENT>;',
        'class Child implements Box<ARGUMENT> {}',
        'class Child implements number<ARGUMENT> {}',
        'const value = new Box<ARGUMENT>();',
        'const value = make<ARGUMENT>();',
      ]) {
        const start = template.indexOf('ARGUMENT');
        const following = '\nconst following = 1;';
        const sourceFor = (argument: string): string => template.replace('ARGUMENT', argument) + following;
        const check = (tree: Tree, argument: string): void => {
          const source = sourceFor(argument);
          const reference = ts.createSourceFile(
            dialect === 'tsx' ? 'recovery.tsx' : 'recovery.ts',
            source,
            ts.ScriptTarget.Latest,
            true,
            dialect === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
          );
          const options = { noLib: true, noResolve: true };
          const host = ts.createCompilerHost(options);
          host.getSourceFile = (name) => (name === reference.fileName ? reference : undefined);
          const program = ts.createProgram([reference.fileName], options, host);
          expect(program.getSyntacticDiagnostics(reference), source).toHaveLength(0);
          const empty = argument === '' || argument === '/* gap */';
          expect(tree.rootNode.hasError, source).toBe(empty);
          expect(
            tree.rootNode.namedChildren.some((node) => node.type === 'ERROR'),
            source
          ).toBe(false);
          expect(tree.rootNode.lastNamedChild?.text).toBe('const following = 1;');
          const argumentsNode = tree.rootNode.descendantsOfType('type_arguments')[0]!;
          expect(argumentsNode?.text, source).toBe(`<${argument}>`);
          expect(argumentsNode.startIndex).toBe(start - 1);
          expect(argumentsNode.endIndex).toBe(start + argument.length + 1);
          const argumentsTypes = argumentsNode.namedChildren.filter((node) => node.type !== 'comment');
          expect(argumentsTypes.map((node) => [node.type, node.text, node.isMissing])).toEqual([
            ['type_identifier', empty ? '' : 'Value', empty],
          ]);
          if (template.startsWith('class')) {
            expect(tree.rootNode.firstNamedChild?.type).toBe('class_declaration');
            expect(tree.rootNode.descendantsOfType('class_body')).toHaveLength(1);
          }
          if (template.startsWith('let')) expect(tree.rootNode.descendantsOfType('type_annotation')).toHaveLength(1);
        };
        for (const argument of ['', 'Value', 'Value,', '/* gap */', 'Value /* gap */,']) {
          const tree = parser.parse(sourceFor(argument))!;
          try {
            check(tree, argument);
          } finally {
            tree.delete();
          }
        }
      }
    } finally {
      parser.delete();
    }
  });
}

function implementedTypes(tree: Tree): string[] {
  return tree.rootNode
    .descendantsOfType('implements_clause')
    .flatMap((clause) => clause.namedChildren.filter((node) => node.type !== 'comment').map((node) => node.text));
}
