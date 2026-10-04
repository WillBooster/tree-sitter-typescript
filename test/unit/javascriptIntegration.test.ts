import assert from 'node:assert/strict';

import { expect, test } from 'vitest';
import { Edit, Parser, Query, type Node } from '@willbooster/web-tree-sitter';

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

  test(`${dialect} restores typed await and statement boundaries after comment edits`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    const prefix = 'async function f() { await g<T>(x)\n';
    const suffix = '!h; }';
    let source = `${prefix}${suffix}`;
    let tree = parser.parse(source);
    assert.ok(tree);
    let comment = '';
    try {
      for (const replacement of ['// boundary\n', '/* boundary */', '/* boundary\n */', '', '/* unfinished', '']) {
        const next = prefix + replacement + suffix;
        tree.edit(
          new Edit({
            startIndex: prefix.length,
            oldEndIndex: prefix.length + comment.length,
            newEndIndex: prefix.length + replacement.length,
            startPosition: position(source, prefix.length),
            oldEndPosition: position(source, prefix.length + comment.length),
            newEndPosition: position(next, prefix.length + replacement.length),
          })
        );
        const edited = parser.parse(next, tree);
        const fresh = parser.parse(next);
        assert.ok(edited);
        assert.ok(fresh);
        try {
          expect(snapshot(edited.rootNode)).toEqual(snapshot(fresh.rootNode));
          if (!replacement.includes('unfinished')) {
            expect(edited.rootNode.hasError).toBe(false);
            const [body] = edited.rootNode.descendantsOfType('statement_block');
            expect(body?.namedChildren.filter((node) => node.type !== 'comment').map((node) => node.type)).toEqual([
              'expression_statement',
              'expression_statement',
            ]);
            const [awaitNode] = edited.rootNode.descendantsOfType('await_expression');
            expect(awaitNode?.text).toBe('await g<T>(x)');
            expect(edited.rootNode.descendantsOfType('unary_expression').map((node) => node.text)).toEqual(['!h']);
          } else {
            expect(edited.rootNode.hasError).toBe(true);
          }
        } finally {
          fresh.delete();
        }
        tree.delete();
        tree = edited;
        source = next;
        comment = replacement;
      }
    } finally {
      tree.delete();
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

  test(`${dialect} restores restricted return and regex boundaries across adjacent comment edits`, () => {
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
    const prefix = 'function f(){return';
    const suffix = '/b/.test(x);}';
    let comment = '/*\nx*/';
    let source = prefix + comment + suffix;
    let tree = parser.parse(source);
    assert.ok(tree);
    try {
      for (const replacement of [
        '/*\nx*//* second */',
        '/* same line */',
        '// boundary\n',
        '/* unfinished',
        '/*\nx*/',
      ]) {
        const next = prefix + replacement + suffix;
        tree.edit(
          new Edit({
            startIndex: prefix.length,
            oldEndIndex: prefix.length + comment.length,
            newEndIndex: prefix.length + replacement.length,
            startPosition: position(source, prefix.length),
            oldEndPosition: position(source, prefix.length + comment.length),
            newEndPosition: position(next, prefix.length + replacement.length),
          })
        );
        const edited = parser.parse(next, tree);
        const fresh = parser.parse(next);
        assert.ok(edited);
        assert.ok(fresh);
        try {
          expect(snapshot(edited.rootNode)).toEqual(snapshot(fresh.rootNode));
          if (replacement.includes('unfinished')) {
            expect(edited.rootNode.hasError).toBe(true);
          } else {
            expect(edited.rootNode.hasError).toBe(false);
            const [returnNode] = edited.rootNode.descendantsOfType('return_statement');
            expect(
              returnNode?.namedChildren.filter((node) => node.type !== 'comment').map((node) => node.type)
            ).toEqual(replacement.includes('\n') ? [] : ['call_expression']);
            expect(edited.rootNode.descendantsOfType('expression_statement')).toHaveLength(
              replacement.includes('\n') ? 1 : 0
            );
            expect(edited.rootNode.descendantsOfType('regex').map((node) => node.text)).toEqual(['/b/']);
          }
        } finally {
          fresh.delete();
        }
        tree.delete();
        tree = edited;
        source = next;
        comment = replacement;
      }
    } finally {
      tree.delete();
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
          expect(tree.rootNode.descendantsOfType('for_in_statement')[0]?.childForFieldName('left')?.text).toBe(name);
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

  test(`${dialect} excludes trailing comments from typed function bodies while preserving statement queries`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse('function f<T>(x: T): T {}/* trailing */');
    assert.ok(tree);
    const query = new Query(language, '(statement) @statement\n(declaration) @declaration');
    try {
      expect(tree.rootNode.hasError).toBe(false);
      const [functionNode] = tree.rootNode.descendantsOfType('function_declaration');
      expect(functionNode?.text).toBe('function f<T>(x: T): T {}');
      expect(functionNode?.childForFieldName('body')?.text).toBe('{}');
      expect(tree.rootNode.descendantsOfType('comment').map((node) => node.text)).toEqual(['/* trailing */']);
      const captures = query.captures(tree.rootNode);
      for (const name of ['statement', 'declaration']) {
        expect(captures.filter((capture) => capture.name === name).map((capture) => capture.node.id)).toContain(
          functionNode?.id
        );
      }
    } finally {
      query.delete();
      tree.delete();
      parser.delete();
    }
  });
}

function position(source: string, index: number): { row: number; column: number } {
  const prefix = source.slice(0, index);
  return { row: prefix.split('\n').length - 1, column: index - prefix.lastIndexOf('\n') - 1 };
}

function snapshot(node: Node): unknown {
  return {
    type: node.type,
    start: node.startIndex,
    end: node.endIndex,
    missing: node.isMissing,
    children: node.children.map(snapshot),
  };
}
