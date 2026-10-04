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
