import assert from 'node:assert/strict';

import { Parser, Query } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

import { loadCurrentWasmBuild } from './wasmBuild';

await Parser.init();

for (const dialect of ['typescript', 'tsx']) {
  const language = await loadCurrentWasmBuild(dialect);

  test(`${dialect} keeps typed calls inside a multiline await operand and outside its binary continuation`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse('async function f() { return await\n/* operand */ g<T>(x) + h; }');
    assert.ok(tree);
    const query = new Query(language, '(await_expression (expression) @operand) @await');
    try {
      expect(tree.rootNode.hasError).toBe(false);
      const captures = query.captures(tree.rootNode);
      expect(captures.filter(({ name }) => name === 'operand').map(({ node }) => node.text)).toEqual(['g<T>(x)']);
      const [awaitNode] = tree.rootNode.descendantsOfType('await_expression');
      expect(awaitNode?.parent?.type).toBe('binary_expression');
      const [call] = tree.rootNode.descendantsOfType('call_expression');
      expect(call?.childForFieldName('type_arguments')?.text).toBe('<T>');
      expect(call?.childForFieldName('function')?.text).toBe('g');
      expect(call?.childForFieldName('arguments')?.text).toBe('(x)');
    } finally {
      query.delete();
      tree.delete();
      parser.delete();
    }
  });

  test(`${dialect} keeps typed await and statement boundaries around comments`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    try {
      for (const comment of ['// boundary\n', '/* boundary */', '/* boundary\n */', '', '/* unfinished']) {
        const tree = parser.parse(`async function f() { await g<T>(x)\n${comment}!h; }`);
        assert.ok(tree);
        try {
          if (!comment.includes('unfinished')) {
            expect(tree.rootNode.hasError).toBe(false);
            const [body] = tree.rootNode.descendantsOfType('statement_block');
            expect(body?.namedChildren.filter((node) => node.type !== 'comment').map((node) => node.type)).toEqual([
              'expression_statement',
              'expression_statement',
            ]);
            const [awaitNode] = tree.rootNode.descendantsOfType('await_expression');
            expect(awaitNode?.text).toBe('await g<T>(x)');
            expect(tree.rootNode.descendantsOfType('unary_expression').map((node) => node.text)).toEqual(['!h']);
          } else {
            expect(tree.rootNode.hasError).toBe(true);
          }
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });

  test(`${dialect} keeps commented union and intersection types in their declarations`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    try {
      for (const comment of ['// boundary\n', '/* boundary\n */', '/* boundary\n *//* second */']) {
        const tree = parser.parse(`type A = 'a' ${comment}| 'b';\ntype B = A ${comment}& C;`);
        assert.ok(tree);
        try {
          expect(tree.rootNode.hasError).toBe(false);
          expect(tree.rootNode.namedChildren.map((node) => node.type)).toEqual([
            'type_alias_declaration',
            'type_alias_declaration',
          ]);
          const declarations = tree.rootNode.descendantsOfType('type_alias_declaration');
          expect(declarations.map((node) => node.childForFieldName('value')?.type)).toEqual([
            'union_type',
            'intersection_type',
          ]);
          expect(tree.rootNode.descendantsOfType('comment')).toHaveLength(comment.includes('second') ? 4 : 2);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });

  test(`${dialect} keeps conditional await arrow bodies and optional parameters`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    const query = new Query(language, '(await_expression (expression) @operand)');
    try {
      for (const operand of ['g(x)', 'g<T>(x)', 'g!()', 'g?.<T>(x)']) {
        for (const comment of ['', '/* boundary\n */', '// boundary\n']) {
          const tree = parser.parse(`const f = async (x?: T, y?: U) => await ${operand} ${comment}? x : undefined;`);
          assert.ok(tree);
          try {
            expect(tree.rootNode.hasError).toBe(false);
            const [arrow] = tree.rootNode.descendantsOfType('arrow_function');
            const body = arrow?.childForFieldName('body');
            expect(body?.type).toBe('ternary_expression');
            expect(body?.childForFieldName('condition')?.text).toBe(`await ${operand}`);
            expect(body?.childForFieldName('consequence')?.text).toBe('x');
            expect(body?.childForFieldName('alternative')?.text).toBe('undefined');
            expect(tree.rootNode.descendantsOfType('optional_parameter').map((node) => node.text)).toEqual([
              'x?: T',
              'y?: U',
            ]);
            expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toEqual([operand]);
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

  test(`${dialect} keeps restricted return and regex boundaries around adjacent comments`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    const declaration = parser.parse('let a/*\nx*//b/.test(x);');
    assert.ok(declaration);
    try {
      expect(declaration.rootNode.hasError).toBe(false);
      expect(
        declaration.rootNode.namedChildren.filter((node) => node.type !== 'comment').map((node) => node.type)
      ).toEqual(['lexical_declaration', 'expression_statement']);
    } finally {
      declaration.delete();
    }
    try {
      for (const comment of ['/*\nx*/', '/*\nx*//* second */', '/* same line */', '// boundary\n', '/* unfinished']) {
        const tree = parser.parse(`function f(){return${comment}/b/.test(x);}`);
        assert.ok(tree);
        try {
          if (comment.includes('unfinished')) {
            expect(tree.rootNode.hasError).toBe(true);
          } else {
            expect(tree.rootNode.hasError).toBe(false);
            const [returnNode] = tree.rootNode.descendantsOfType('return_statement');
            expect(
              returnNode?.namedChildren.filter((node) => node.type !== 'comment').map((node) => node.type)
            ).toEqual(comment.includes('\n') ? [] : ['call_expression']);
            expect(tree.rootNode.descendantsOfType('expression_statement')).toHaveLength(
              comment.includes('\n') ? 1 : 0
            );
            expect(tree.rootNode.descendantsOfType('regex').map((node) => node.text)).toEqual(['/b/']);
          }
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });

  test(`${dialect} ends an await identifier statement before a namespace declaration`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    const query = new Query(
      language,
      '(expression_statement (identifier) @await)\n(expression_statement (internal_module) @namespace)'
    );
    try {
      for (const comment of ['\n', '/* boundary\n */', '\n// boundary\n']) {
        for (const wrapped of [false, true]) {
          const statements = `await${comment}namespace N {}`;
          const tree = parser.parse(wrapped ? `function f(){${statements}}` : statements);
          assert.ok(tree);
          try {
            expect(tree.rootNode.hasError).toBe(false);
            expect(tree.rootNode.descendantsOfType('await_expression')).toHaveLength(0);
            const captures = query.captures(tree.rootNode);
            expect(captures.filter(({ name }) => name === 'await').map(({ node }) => node.text)).toEqual(['await']);
            expect(captures.filter(({ name }) => name === 'namespace').map(({ node }) => node.text)).toEqual([
              'namespace N {}',
            ]);
          } finally {
            tree.delete();
          }
        }
      }
      for (const operand of ['namespace(x)', 'namespace.x', 'namespace / g / x']) {
        const tree = parser.parse(`async function f(){return await\n${operand};}`);
        assert.ok(tree);
        try {
          expect(tree.rootNode.hasError).toBe(false);
          expect(tree.rootNode.descendantsOfType('internal_module')).toHaveLength(0);
          expect(tree.rootNode.descendantsOfType('await_expression').map((node) => node.text)).toEqual([
            `await\n${operand.startsWith('namespace /') ? 'namespace' : operand}`,
          ]);
        } finally {
          tree.delete();
        }
      }
    } finally {
      query.delete();
      parser.delete();
    }
  });

  test(`${dialect} preserves i-initial await using bindings and genuine binary keywords`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    try {
      for (const name of ['i', 'install', 'inside', 'instanceofX', 'i漢字']) {
        const source = `async function f(){await using ${name} = g(); for(await using ${name} of values){} for(await using ${name} = g();;){}}`;
        const tree = parser.parse(source);
        assert.ok(tree);
        try {
          expect(tree.rootNode.hasError).toBe(false);
          expect(tree.rootNode.descendantsOfType('await_expression')).toHaveLength(0);
          expect(tree.rootNode.descendantsOfType('using_declaration')[0]?.childForFieldName('kind')?.text).toBe(
            'await'
          );
          expect(
            tree.rootNode.descendantsOfType('variable_declarator').map((node) => node.childForFieldName('name')?.text)
          ).toEqual([name, name]);
          expect(
            tree.rootNode
              .descendantsOfType('for_in_statement')[0]
              ?.childForFieldName('header')
              ?.childForFieldName('left')?.text
          ).toBe(name);
        } finally {
          tree.delete();
        }
      }
      for (const operator of ['in', 'instanceof']) {
        const tree = parser.parse(`async function f(){return await g<T>(x) ${operator} values;}`);
        assert.ok(tree);
        try {
          expect(tree.rootNode.hasError).toBe(false);
          const [binary] = tree.rootNode.descendantsOfType('binary_expression');
          expect(binary?.childForFieldName('left')?.text).toBe('await g<T>(x)');
          expect(binary?.childForFieldName('operator')?.text).toBe(operator);
          expect(binary?.childForFieldName('right')?.text).toBe('values');
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });

  test(`${dialect} continues qualified types across comments while ending before decimal statements`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    try {
      for (const comment of ['// boundary\n', '/* boundary\n */', '/* boundary\n *//* second */']) {
        const tree = parser.parse(`type X = A${comment}.B; type Y = typeof a${comment}.b;`);
        assert.ok(tree);
        try {
          expect(tree.rootNode.hasError).toBe(false);
          expect(tree.rootNode.namedChildren.map((node) => node.type)).toEqual([
            'type_alias_declaration',
            'type_alias_declaration',
          ]);
          expect(
            tree.rootNode
              .descendantsOfType('type_alias_declaration')
              .map((node) => node.childForFieldName('value')?.text)
          ).toEqual([`A${comment}.B`, `typeof a${comment}.b`]);
        } finally {
          tree.delete();
        }
        const decimal = parser.parse(`type X = A${comment}.1;`);
        assert.ok(decimal);
        try {
          expect(decimal.rootNode.hasError).toBe(false);
          expect(
            decimal.rootNode.descendantsOfType('type_alias_declaration')[0]?.childForFieldName('value')?.text
          ).toBe('A');
          expect(decimal.rootNode.descendantsOfType('expression_statement').map((node) => node.text)).toEqual(['.1;']);
        } finally {
          decimal.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });

  test(`${dialect} attaches class bodies after comments`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    const query = new Query(language, '(method_definition body: (statement_block) @body)');
    try {
      for (const [header, body] of [
        ['m()', '{}'],
        ['m(): void', '{}'],
        ['constructor(a: string)', '{}'],
        ['get x(): number', '{ return 1; }'],
        ['set x(v: number)', '{}'],
        ['m<T>(): T', '{ return undefined as T; }'],
      ]) {
        for (const comment of [' // boundary', ' /* boundary\n */', ' /* first */// boundary', '', ' // restored']) {
          const tree = parser.parse(`class C {\n${header}${comment}\n${body}\n}`);
          assert.ok(tree);
          try {
            expect(tree.rootNode.hasError).toBe(false);
            expect(tree.rootNode.namedChildren.map((node) => node.type)).toEqual(['class_declaration']);
            expect(tree.rootNode.descendantsOfType('method_definition')).toHaveLength(1);
            expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toEqual([body]);
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

  test(`${dialect} preserves typed declaration continuations after comments`, () => {
    const parser = new Parser().setLanguage(language);
    const query = new Query(language, '(predefined_type) @type');
    try {
      for (const [prefix, suffix, type] of [
        ['interface I { a', '\n: string; }', 'string'],
        ['interface I { a', '\n?: string; }', 'string'],
        ['type T = { m()', '\n: void; };', 'void'],
        ['interface I extends Foo', '\n<number> {}', 'number'],
        ['let x: { a', '\n: string };', 'string'],
        ['interface I { a: string', '\n; }', 'string'],
      ] as const) {
        for (const comment of [' // boundary', ' /* boundary\n */', ' /* first */// boundary', '', ' // restored']) {
          const tree = parser.parse(prefix + comment + suffix);
          assert.ok(tree);
          try {
            expect(tree.rootNode.hasError).toBe(false);
            expect(tree.rootNode.namedChildren).toHaveLength(1);
            expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toEqual([type]);
            const [property] = tree.rootNode.descendantsOfType('property_signature');
            if (property) {
              expect(property.childForFieldName('name')?.text).toBe('a');
              expect(property.childForFieldName('type')?.text).toBe(': string');
            }
            const [method] = tree.rootNode.descendantsOfType('method_signature');
            if (method) {
              expect(method.childForFieldName('parameters')?.text).toBe('()');
              expect(method.childForFieldName('return_type')?.text).toBe(': void');
            }
            const [generic] = tree.rootNode.descendantsOfType('generic_type');
            if (generic) {
              expect(generic.childForFieldName('name')?.text).toBe('Foo');
              expect(generic.childForFieldName('type_arguments')?.text).toBe('<number>');
            }
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

  test(`${dialect} keeps trailing arrow comments outside declarations before a regex`, () => {
    const parser = new Parser().setLanguage(language);
    const query = new Query(
      language,
      '(arrow_function body: (statement_block) @body)\n(comment) @comment\n(regex) @regex'
    );
    const prefix = 'const f = () => {}';
    const suffix = '\n/re/.test(a)\n';
    try {
      for (const comment of [' // boundary', ' /* boundary\n */', ' /* first */// boundary', '', ' // restored']) {
        const tree = parser.parse(prefix + comment + suffix);
        assert.ok(tree);
        try {
          expect(tree.rootNode.hasError).toBe(false);
          const [declaration] = tree.rootNode.descendantsOfType('lexical_declaration');
          const [arrow] = tree.rootNode.descendantsOfType('arrow_function');
          expect(declaration?.text).toBe(prefix);
          expect(declaration?.endIndex).toBe(prefix.length);
          expect(arrow?.text).toBe('() => {}');
          expect(arrow?.endIndex).toBe(prefix.length);
          const captures = query.captures(tree.rootNode);
          expect(captures.filter(({ name }) => name === 'body').map(({ node }) => node.text)).toEqual(['{}']);
          expect(captures.filter(({ name }) => name === 'regex').map(({ node }) => node.text)).toEqual(['/re/']);
          for (const { node } of captures.filter(({ name }) => name === 'comment')) {
            expect(node.parent?.type).toBe('program');
          }
        } finally {
          tree.delete();
        }
      }
    } finally {
      query.delete();
      parser.delete();
    }
  });

  test(`${dialect} excludes trailing comments from typed function bodies`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse('function f<T>(x: T): T {}/* trailing */');
    assert.ok(tree);
    try {
      expect(tree.rootNode.hasError).toBe(false);
      const [functionNode] = tree.rootNode.descendantsOfType('function_declaration');
      expect(functionNode?.text).toBe('function f<T>(x: T): T {}');
      expect(functionNode?.childForFieldName('body')?.text).toBe('{}');
      expect(tree.rootNode.descendantsOfType('comment').map((node) => node.text)).toEqual(['/* trailing */']);
    } finally {
      tree.delete();
      parser.delete();
    }
  });
}
