import fs from 'node:fs';
import path from 'node:path';

import { Edit, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { compareEditedTree, position } from '../helpers/treeEdit.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

const Source = fs.readFileSync(path.join(import.meta.dirname, '../fixtures/functionTypeParameterNames.ts'), 'utf8');

describe.each(['typescript', 'tsx'])('%s function-type parameter names', (dialect) => {
  let language: Awaited<ReturnType<typeof loadCurrentWasmBuild>>;
  let query: Query | undefined;
  beforeAll(async () => {
    await Parser.init();
    language = await loadCurrentWasmBuild(dialect);
    query = new Query(
      language,
      `
      [(required_parameter pattern: (pattern/identifier) @name)
       (optional_parameter pattern: (pattern/identifier) @name)]
      [(required_parameter type: (type_annotation (_) @type))
       (optional_parameter type: (type_annotation (_) @type))]
      (array (identifier) @reference)
      (pair value: (identifier) @reference)
      (primary_expression/identifier) @primary
    `
    );
  }, 30_000);
  afterAll(() => query?.delete());
  test('preserves the type field after extra-colon edits', () => {
    const parser = new Parser().setLanguage(language);
    const recoveryQuery = new Query(language, '(parenthesized_expression type: (type_annotation) @annotation)');
    let source = 'const x = (unknown: x: number);';
    let tree: Tree | undefined;
    try {
      tree = parser.parse(source)!;
      check(tree, source, ': number');
      for (const [before, after, annotation] of [
        [': x: number', ': x', ': x'],
        [': x', ': x: number', ': number'],
        ['unknown', 'never', ': number'],
        ['never', 'unknown', ': number'],
      ]) {
        const start = source.indexOf(before!);
        const next = source.slice(0, start) + after + source.slice(start + before!.length);
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex: start,
            oldEndIndex: start + before!.length,
            newEndIndex: start + after!.length,
            startPosition: position(source, start),
            oldEndPosition: position(source, start + before!.length),
            newEndPosition: position(next, start + after!.length),
          }),
          (incremental, fresh) => {
            check(incremental, next, annotation!);
            check(fresh, next, annotation!);
          },
          true
        );
        previous.delete();
        source = next;
      }
      function check(current: Tree, text: string, annotation: string): void {
        expect(current.rootNode.hasError).toBe(annotation === ': number');
        const start = text.lastIndexOf(annotation);
        expect(
          recoveryQuery.captures(current.rootNode).map(({ node }) => [node.text, node.startIndex, node.endIndex])
        ).toEqual([[annotation, start, start + annotation.length]]);
      }
    } finally {
      tree?.delete();
      recoveryQuery.delete();
      parser.delete();
    }
  });
  test.each(['unknown', 'never', 'unique'])('retains the annotated %s expression through arrow edits', (name) => {
    const parser = new Parser().setLanguage(language);
    const roleQuery = new Query(
      language,
      `
      (labeled_statement label: (statement_identifier) @label)
      (parenthesized_expression (identifier) @expression_name)
      (primary_expression/identifier) @primary
      (parenthesized_expression type: (type_annotation (predefined_type) @type))
      (required_parameter pattern: (pattern/identifier) @binding_name
        type: (type_annotation (predefined_type) @type))
    `
    );
    let source = `${name}: { const x = (${name} /* annotation */: number); }`;
    let tree: Tree | undefined;
    try {
      tree = parser.parse(source)!;
      check(tree, source, 'expression_name');
      for (const [before, after, role, error] of [
        [';', ` => ${name};`, 'binding_name', false],
        [` => ${name};`, ';', 'expression_name', false],
        ['number', '', 'expression_name', true],
        [': );', ': number);', 'expression_name', false],
      ] as const) {
        const start = source.indexOf(before);
        expect(start).toBeGreaterThanOrEqual(0);
        const next = source.slice(0, start) + after + source.slice(start + before.length);
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex: start,
            oldEndIndex: start + before!.length,
            newEndIndex: start + after!.length,
            startPosition: position(source, start),
            oldEndPosition: position(source, start + before!.length),
            newEndPosition: position(next, start + after!.length),
          }),
          (incremental, fresh) => {
            check(incremental, next, role, error);
            check(fresh, next, role, error);
          },
          error
        );
        previous.delete();
        source = next;
      }
      function check(current: Tree, text: string, role: string, error = false): void {
        expect(current.rootNode.hasError).toBe(error);
        const nameStart = text.indexOf(name, text.indexOf('('));
        const typeStart = text.indexOf('number');
        expect(
          roleQuery
            .captures(current.rootNode)
            .filter(({ name }) => name !== 'primary')
            .map(({ name, node }) => [name, node.text, node.startIndex, node.endIndex])
        ).toEqual([
          ['label', name, 0, name.length],
          [role, name, nameStart, nameStart + name.length],
          ...(typeStart === -1 ? [] : [['type', 'number', typeStart, typeStart + 'number'.length]]),
        ]);
        if (role === 'expression_name') {
          expect(
            roleQuery
              .captures(current.rootNode)
              .some(
                ({ name: capture, node }) =>
                  capture === 'primary' && node.startIndex === nameStart && node.endIndex === nameStart + name.length
              )
          ).toBe(true);
        }
      }
    } finally {
      tree?.delete();
      roleQuery.delete();
      parser.delete();
    }
  });
  test('retains the type alias result through invalid constructor bindings', () => {
    const parser = new Parser().setLanguage(language);
    const recoveryQuery = new Query(
      language,
      '[(type_alias_declaration value: (predefined_type) @result) (type_alias_declaration value: (constructor_type type: (predefined_type) @result))]'
    );
    let source = 'type F = new (void: T[]) => unknown;';
    let tree: Tree | undefined;
    try {
      tree = parser.parse(source)!;
      check(tree, source);
      const start = source.indexOf('void');
      for (const [before, after] of [
        ['void', 'value'],
        ['value', 'void'],
        ['void', '#unknown'],
        ['#unknown', 'void'],
      ]) {
        const next = source.slice(0, start) + after + source.slice(start + before!.length);
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex: start,
            oldEndIndex: start + before!.length,
            newEndIndex: start + after!.length,
            startPosition: position(source, start),
            oldEndPosition: position(source, start + before!.length),
            newEndPosition: position(next, start + after!.length),
          }),
          (incremental, fresh) => {
            check(incremental, next);
            check(fresh, next);
          },
          true
        );
        previous.delete();
        expect(tree.rootNode.hasError).toBe(after !== 'value');
        source = next;
      }
      function check(current: Tree, text: string): void {
        const start = text.lastIndexOf('unknown');
        expect(
          recoveryQuery.captures(current.rootNode).map(({ node }) => [node.text, node.startIndex, node.endIndex])
        ).toEqual([['unknown', start, start + 'unknown'.length]]);
      }
    } finally {
      tree?.delete();
      recoveryQuery.delete();
      parser.delete();
    }
  });
  test.each([
    '(unknown: unknown)',
    '(never: never)',
    '(unique: unknown)',
    '(unknown?: number',
    ', never?: string,',
    ', unique?: string) => string',
    '[unknown,',
    ', never,',
    ', unique];',
    'unknown /* binding',
    'never /* optional',
    'unique // binding',
  ])('preserves %s name and type through edits', (marker) => {
    const parser = new Parser().setLanguage(language);
    let tree: Tree | undefined;
    let source = Source;
    try {
      tree = parser.parse(source)!;
      check(tree, source);
      const word = marker.includes('unique') ? 'unique' : marker.includes('unknown') ? 'unknown' : 'never';
      const markerStart = source.indexOf(marker);
      expect(markerStart).toBeGreaterThanOrEqual(0);
      const start = markerStart + marker.indexOf(word);
      for (const [before, after] of [
        [word, 'parameter'],
        ['parameter', word],
      ]) {
        const next = source.slice(0, start) + after + source.slice(start + before!.length);
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex: start,
            oldEndIndex: start + before!.length,
            newEndIndex: start + after!.length,
            startPosition: position(source, start),
            oldEndPosition: position(source, start + before!.length),
            newEndPosition: position(next, start + after!.length),
          }),
          (incremental, fresh) => {
            check(incremental, next);
            check(fresh, next);
          }
        );
        previous.delete();
        source = next;
      }
      expect(source).toBe(Source);
      function check(current: Tree, text: string): void {
        const reference = ts.createSourceFile('parameters.ts', text, ts.ScriptTarget.Latest, true);
        const expected: [string, string, number, number][] = [];
        const visit = (node: ts.Node): void => {
          if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
            expected.push(['name', node.name.getText(reference), node.name.getStart(reference), node.name.getEnd()]);
            if (node.type)
              expected.push(['type', node.type.getText(reference), node.type.getStart(reference), node.type.getEnd()]);
          }
          if (
            ts.isIdentifier(node) &&
            (ts.isArrayLiteralExpression(node.parent) ||
              (ts.isPropertyAssignment(node.parent) && node.parent.initializer === node))
          ) {
            expected.push(['reference', node.getText(reference), node.getStart(reference), node.getEnd()]);
          }
          ts.forEachChild(node, visit);
        };
        visit(reference);
        expect(current.rootNode.hasError).toBe(false);
        const captures = query!.captures(current.rootNode);
        expect(
          captures
            .filter(({ name }) => name !== 'primary')
            .map(({ name, node }) => [name, node.text, node.startIndex, node.endIndex])
        ).toEqual(expected);
        for (const reference of captures.filter(({ name }) => name === 'reference')) {
          expect(
            captures.some(
              ({ name, node }) =>
                name === 'primary' &&
                node.startIndex === reference.node.startIndex &&
                node.endIndex === reference.node.endIndex
            )
          ).toBe(true);
        }
      }
    } finally {
      tree?.delete();
      parser.delete();
    }
  });
});
