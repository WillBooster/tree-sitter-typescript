import { Edit, Parser, Query } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

import { compareEditedTree, position } from '../helpers/treeEdit';
import { loadCurrentWasmBuild } from './wasmBuild';

await Parser.init();

for (const dialect of ['typescript', 'tsx']) {
  const language = await loadCurrentWasmBuild(dialect);
  test(`${dialect} restores outer await and yield after typed nested function scopes`, () => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const [keyword, outer, inner] of [
        ['await', 'async function', 'function inner<U>(x:U):U { return await(x) }'],
        ['await', 'async function', 'const inner = function<U>(x:U):U { return await(x) };'],
        ['await', 'async function', 'const obj = { method<U>(x:U):U { return await(x) } };'],
        ['await', 'async function', 'class C { method<U>(x:U):U { return await(x) } }'],
        ['await', 'async function', 'class C { field = await(x); }'],
        ['yield', 'function*', 'function inner<U>(x:U):U { return yield(x) }'],
        ['yield', 'function*', 'const obj = { method<U>(x:U):U { return yield(x) } };'],
      ]) {
        const source = `${outer} outer<T>(input:T) { ${inner} return ${keyword} input; }\nconst following = 1;`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(tree.rootNode.descendantsOfType(`${keyword}_expression`).map((node) => node.text)).toEqual([
            `${keyword} input`,
          ]);
          const call = tree.rootNode.descendantsOfType('call_expression')[0]!;
          expect(call.text).toBe(`${keyword}(x)`);
          expect(call.childForFieldName('function')?.type).toBe('identifier');
          expect(tree.rootNode.lastNamedChild?.text).toBe('const following = 1;');
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });

  test(`${dialect} changes typed nested async scopes without stale operand nodes or captures`, () => {
    const parser = new Parser().setLanguage(language);
    const query = new Query(language, '(await_expression) @await (call_expression function: (identifier) @call)');
    const prefix = 'async function outer<T>(input:T) { ';
    const suffix = 'function inner<U>(x:U):U { return await(x) } return await input; }';
    let source = prefix + suffix;
    let modifier = '';
    let tree = parser.parse(source)!;
    const captures = (current: typeof tree): unknown =>
      query.captures(current.rootNode).map(({ name, node }) => [name, node.text, node.startIndex, node.endIndex]);
    try {
      for (const replacement of ['async ', '', 'async /* boundary */ ', '']) {
        const next = prefix + replacement + suffix;
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex: prefix.length,
            oldEndIndex: prefix.length + modifier.length,
            newEndIndex: prefix.length + replacement.length,
            startPosition: position(source, prefix.length),
            oldEndPosition: position(source, prefix.length + modifier.length),
            newEndPosition: position(next, prefix.length + replacement.length),
          }),
          (incremental, fresh) => {
            expect(captures(incremental)).toEqual(captures(fresh));
            expect(incremental.rootNode.descendantsOfType('await_expression').map((node) => node.text)).toEqual(
              replacement ? ['await(x)', 'await input'] : ['await input']
            );
            expect(incremental.rootNode.descendantsOfType('call_expression').map((node) => node.text)).toEqual(
              replacement ? [] : ['await(x)']
            );
          }
        );
        previous.delete();
        source = next;
        modifier = replacement;
      }
    } finally {
      tree.delete();
      query.delete();
      parser.delete();
    }
  });

  test(`${dialect} separates bodyless signatures from following expressions and is-named members`, () => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const [signature, expression] of [
        ['declare function f()', 'is();'],
        ['declare function f()', '[1].map(g);'],
        ['declare function f()', '.5;'],
        ['declare function f(): T', 'is();'],
        ['declare function f(): T', '[1].map(g);'],
        ['declare function f(): T', '.5;'],
      ]) {
        const source = `${signature}\n${expression}\nconst following = 1;`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(tree.rootNode.descendantsOfType('function_signature')).toHaveLength(1);
          expect(tree.rootNode.descendantsOfType('expression_statement').map((node) => node.text)).toEqual([
            expression,
          ]);
          expect(tree.rootNode.lastNamedChild?.text).toBe('const following = 1;');
        } finally {
          tree.delete();
        }
      }
      for (const first of ['foo()', 'foo(): T']) {
        const source = `interface I { ${first}\nis(): void; after(): void }`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(
            tree.rootNode.descendantsOfType('method_signature').map((node) => node.childForFieldName('name')?.text)
          ).toEqual(['foo', 'is', 'after']);
        } finally {
          tree.delete();
        }
      }
      for (const returnType of ['T', 'T[K]', 'T[]']) {
        const source = `interface I { foo(): ${returnType}\n/* member */ [Symbol.observable](): T; after(): void }`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          const signatures = tree.rootNode.descendantsOfType('method_signature');
          expect(signatures.map((node) => node.childForFieldName('name')?.text)).toEqual([
            'foo',
            '[Symbol.observable]',
            'after',
          ]);
          expect(signatures[0]!.childForFieldName('return_type')?.text).toBe(`: ${returnType}`);
        } finally {
          tree.delete();
        }
      }
      for (const returnType of ['T', 'asserts x is T']) {
        for (const member of ['[k: string]: T', '<U>(x: U): U', 'extends(): void']) {
          const source = `interface I { foo(x: T): ${returnType}\n${member}; after(): void }`;
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(false);
            const first = tree.rootNode.descendantsOfType('method_signature')[0]!;
            expect(first.childForFieldName('return_type')?.text).toBe(`: ${returnType}`);
            expect(tree.rootNode.descendantsOfType('interface_body')[0]!.namedChildren).toHaveLength(3);
          } finally {
            tree.delete();
          }
        }
      }
    } finally {
      parser.delete();
    }
  });

  test(`${dialect} retains generic async arrow signatures and their await scopes`, () => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const expression of [
        'async <T,>(x: T) => x',
        'async <T,>(x: T) => await x',
        'async/* same line */<T,>(x:T): Promise<T> => { return await x }',
      ]) {
        const source = `const f = ${expression};\nconst following = 1;`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          const arrow = tree.rootNode.descendantsOfType('arrow_function');
          expect(arrow).toHaveLength(1);
          expect(arrow[0]!.childForFieldName('type_parameters')?.text).toBe('<T,>');
          expect(tree.rootNode.descendantsOfType('binary_expression')).toHaveLength(0);
          expect(tree.rootNode.descendantsOfType('await_expression').map((node) => node.text)).toEqual(
            expression.includes('await') ? ['await x'] : []
          );
          expect(tree.rootNode.lastNamedChild?.text).toBe('const following = 1;');
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });

  test(`${dialect} completes constructors in fields and arrows before ending their scopes`, () => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const name of ['i', 'ingestUtils', 'instanceofCtor']) {
        for (const trivia of [' ', '\n']) {
          for (const expression of [
            `class C { private readonly field = new${trivia}${name}.Ctor(); }`,
            `const f = () => new${trivia}${name}.Ctor();`,
          ]) {
            const source = `${expression}\nconst following = 1;`;
            const tree = parser.parse(source)!;
            try {
              expect(tree.rootNode.hasError, source).toBe(false);
              const constructors = tree.rootNode.descendantsOfType('new_expression');
              expect(constructors).toHaveLength(1);
              expect(constructors[0]!.childForFieldName('constructor')?.text).toBe(`${name}.Ctor`);
              expect(constructors[0]!.childForFieldName('arguments')?.text).toBe('()');
              expect(tree.rootNode.lastNamedChild?.text).toBe('const following = 1;');
            } finally {
              tree.delete();
            }
          }
        }
      }
      const query = parser.parse('type X = typeof new.foo;')!;
      try {
        expect(query.rootNode.hasError).toBe(false);
        expect(query.rootNode.descendantsOfType('type_query')[0]?.text).toBe('typeof new.foo');
      } finally {
        query.delete();
      }
      for (const source of ['new;', 'class C { field = new; }']) {
        const tree = parser.parse(`${source}\nconst following = 1;`)!;
        try {
          expect(tree.rootNode.hasError).toBe(true);
          expect(tree.rootNode.lastNamedChild?.text).toBe('const following = 1;');
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });

  test(`${dialect} separates next-line logical negation from arrow bodies and retains inequality and non-null calls`, () => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const expression of ['() => a', 'async () => await a']) {
        const tree = parser.parse(`x = ${expression}\n!b;\nconst following = 1;`)!;
        try {
          expect(tree.rootNode.hasError).toBe(false);
          expect(tree.rootNode.descendantsOfType('arrow_function')[0]!.text).toBe(expression);
          expect(tree.rootNode.descendantsOfType('unary_expression').map((node) => node.text)).toEqual(['!b']);
          expect(tree.rootNode.lastNamedChild?.text).toBe('const following = 1;');
        } finally {
          tree.delete();
        }
      }
      for (const operator of ['!=', '!==']) {
        const tree = parser.parse(`const f = () => a\n${operator} b;`)!;
        try {
          expect(tree.rootNode.hasError).toBe(false);
          expect(tree.rootNode.descendantsOfType('arrow_function')[0]!.childForFieldName('body')?.text).toBe(
            `a\n${operator} b`
          );
        } finally {
          tree.delete();
        }
      }
      const tree = parser.parse('const f = () => a!();')!;
      try {
        expect(tree.rootNode.hasError).toBe(false);
        expect(tree.rootNode.descendantsOfType('arrow_function')[0]!.childForFieldName('body')?.type).toBe(
          'call_expression'
        );
        expect(tree.rootNode.descendantsOfType('non_null_expression')[0]?.text).toBe('a!');
      } finally {
        tree.delete();
      }
    } finally {
      parser.delete();
    }
  });

  test(`${dialect} keeps conditional return types on their original line`, () => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const prefix of ['interface I { f(): ', 'declare function f(): ']) {
        const close = prefix.startsWith('interface') ? '; after(): void }' : ';\nconst following = 1;';
        const valid = parser.parse(`${prefix}T extends U ? X : Y${close}`)!;
        const invalid = parser.parse(`${prefix}T\nextends U ? X : Y${close}`)!;
        try {
          expect(valid.rootNode.hasError).toBe(false);
          expect(valid.rootNode.descendantsOfType('conditional_type')).toHaveLength(1);
          expect(invalid.rootNode.hasError).toBe(true);
          expect(invalid.rootNode.descendantsOfType('conditional_type')).toHaveLength(0);
        } finally {
          valid.delete();
          invalid.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });

  test(`${dialect} ends generic method signatures before later members and declarations`, () => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const source of [
        'interface I { foo\n<T>(x:T):void; predicate<T>(x:T): x is T; after():void }\nconst following = 1;',
        'abstract class C { abstract foo\n<T>(x:T):void; after<T>(x:T):T { return x } }\nconst following = 1;',
      ]) {
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          const signatures = tree.rootNode.descendantsOfType(['method_signature', 'abstract_method_signature']);
          expect(signatures[0]?.childForFieldName('name')?.text).toBe('foo');
          expect(signatures[0]?.childForFieldName('type_parameters')?.text).toBe('<T>');
          expect(signatures[0]?.childForFieldName('parameters')?.text).toBe('(x:T)');
          expect(signatures[0]?.childForFieldName('return_type')?.text).toBe(':void');
          expect(tree.rootNode.lastNamedChild?.text).toBe('const following = 1;');
          if (source.startsWith('interface')) {
            expect(signatures.map((node) => node.childForFieldName('name')?.text)).toEqual([
              'foo',
              'predicate',
              'after',
            ]);
            expect(signatures[1]?.childForFieldName('return_type')?.type).toBe('type_predicate_annotation');
          } else {
            expect(tree.rootNode.descendantsOfType('method_definition')[0]?.childForFieldName('body')?.text).toBe(
              '{ return x }'
            );
          }
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });
}
