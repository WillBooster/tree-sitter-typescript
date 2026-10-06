import fs from 'node:fs';
import path from 'node:path';

import { Edit, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import treeSitterJson from '../../tree-sitter.json';

import { compareEditedTree, position } from '../helpers/treeEdit.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

const Source = fs.readFileSync(path.join(import.meta.dirname, '../fixtures/plainPredicateNames.ts'), 'utf8');

describe.each(['typescript', 'tsx'])('%s plain predicate names', (dialect) => {
  let language: Awaited<ReturnType<typeof loadCurrentWasmBuild>>;
  let query: Query | undefined;
  const configured: Query[] = [];
  beforeAll(async () => {
    await Parser.init();
    language = await loadCurrentWasmBuild(dialect);
    query = new Query(language, '(type_predicate name: (identifier) @name type: (_) @type)');
    const grammar = treeSitterJson.grammars.find((entry) => entry.name === dialect)!;
    for (const files of [grammar.highlights, grammar.tags, grammar.locals, grammar.injections])
      configured.push(
        new Query(
          language,
          [files]
            .flat()
            .map((file) => fs.readFileSync(path.join(import.meta.dirname, '../..', file), 'utf8'))
            .join('\n')
        )
      );
  }, 30_000);
  afterAll(() => {
    query?.delete();
    for (const resource of configured) resource.delete();
  });
  test.each([
    'declare function f(is: unknown): is.value is string;\nconst sentinel = 1;\n',
    'declare function f(is: unknown): is : string;\nconst sentinel = 1;\n',
    'declare function f(is: unknown): is number;\nconst sentinel = 1;\n',
    'declare function f(is: unknown): is ? string : number;\nconst sentinel = 1;\n',
    'function f(is: unknown): is.value is string { return true; }\nconst sentinel = 1;\n',
    'function f(is: unknown): is : string { return true; }\nconst sentinel = 1;\n',
    'function f(is: unknown): is number { return true; }\nconst sentinel = 1;\n',
    'function f(is: unknown): is ? string : number { return true; }\nconst sentinel = 1;\n',
    'interface I { m(is: unknown): is.value is string; }\nconst sentinel = 1;\n',
    'interface I { m(is: unknown): is : string; }\nconst sentinel = 1;\n',
    'interface I { m(is: unknown): is number; }\nconst sentinel = 1;\n',
    'interface I { m(is: unknown): is ? string : number; }\nconst sentinel = 1;\n',
    'class C { m(is: unknown): is.value is string { return true; } }\nconst sentinel = 1;\n',
    'class C { m(is: unknown): is : string { return true; } }\nconst sentinel = 1;\n',
    'class C { m(is: unknown): is number { return true; } }\nconst sentinel = 1;\n',
    'class C { m(is: unknown): is ? string : number { return true; } }\nconst sentinel = 1;\n',
    'type T = (is: unknown) => is.value is string;\nconst sentinel = 1;\n',
    'type T = (is: unknown) => is : string;\nconst sentinel = 1;\n',
    'type T = (is: unknown) => is number;\nconst sentinel = 1;\n',
    'type T = (is: unknown) => is ? string : number;\nconst sentinel = 1;\n',
    'interface I { (is: unknown): is.value is string; }\nconst sentinel = 1;\n',
    'interface I { (is: unknown): is : string; }\nconst sentinel = 1;\n',
    'interface I { (is: unknown): is number; }\nconst sentinel = 1;\n',
    'interface I { (is: unknown): is ? string : number; }\nconst sentinel = 1;\n',
    'declare function f(undefined: unknown): undefined is;\nconst sentinel = 1;\n',
    'declare function f(undefined: unknown): undefined.value is string;\nconst sentinel = 1;\n',
    'declare function f(undefined: unknown): undefined ? string : number;\nconst sentinel = 1;\n',
    'declare function f(keyof: unknown): keyof.value is string;\nconst sentinel = 1;\n',
    'declare function f(infer: unknown): infer.value is string;\nconst sentinel = 1;\n',
    'declare function f(readonly: unknown): readonly.value is string;\nconst sentinel = 1;\n',
    'declare function f(abstract: unknown): abstract is;\nconst sentinel = 1;\n',
    'function f(undefined: unknown): undefined is { return true; }\nconst sentinel = 1;\n',
    'function f(undefined: unknown): undefined.value is string { return true; }\nconst sentinel = 1;\n',
    'function f(undefined: unknown): undefined ? string : number { return true; }\nconst sentinel = 1;\n',
    'function f(keyof: unknown): keyof.value is string { return true; }\nconst sentinel = 1;\n',
    'function f(infer: unknown): infer.value is string { return true; }\nconst sentinel = 1;\n',
    'function f(readonly: unknown): readonly.value is string { return true; }\nconst sentinel = 1;\n',
    'function f(abstract: unknown): abstract is { return true; }\nconst sentinel = 1;\n',
    'interface I { m(undefined: unknown): undefined is; }\nconst sentinel = 1;\n',
    'interface I { m(undefined: unknown): undefined.value is string; }\nconst sentinel = 1;\n',
    'interface I { m(undefined: unknown): undefined ? string : number; }\nconst sentinel = 1;\n',
    'interface I { m(keyof: unknown): keyof.value is string; }\nconst sentinel = 1;\n',
    'interface I { m(infer: unknown): infer.value is string; }\nconst sentinel = 1;\n',
    'interface I { m(readonly: unknown): readonly.value is string; }\nconst sentinel = 1;\n',
    'interface I { m(abstract: unknown): abstract is; }\nconst sentinel = 1;\n',
    'class C { m(undefined: unknown): undefined is { return true; } }\nconst sentinel = 1;\n',
    'class C { m(undefined: unknown): undefined.value is string { return true; } }\nconst sentinel = 1;\n',
    'class C { m(undefined: unknown): undefined ? string : number { return true; } }\nconst sentinel = 1;\n',
    'class C { m(keyof: unknown): keyof.value is string { return true; } }\nconst sentinel = 1;\n',
    'class C { m(infer: unknown): infer.value is string { return true; } }\nconst sentinel = 1;\n',
    'class C { m(readonly: unknown): readonly.value is string { return true; } }\nconst sentinel = 1;\n',
    'class C { m(abstract: unknown): abstract is { return true; } }\nconst sentinel = 1;\n',
    'type T = (undefined: unknown) => undefined is;\nconst sentinel = 1;\n',
    'type T = (undefined: unknown) => undefined.value is string;\nconst sentinel = 1;\n',
    'type T = (undefined: unknown) => undefined ? string : number;\nconst sentinel = 1;\n',
    'type T = (keyof: unknown) => keyof is string;\nconst sentinel = 1;\n',
    'type T = (keyof: unknown) => keyof is string[];\nconst sentinel = 1;\n',
    'type T = (keyof: unknown) => keyof is unique symbol;\nconst sentinel = 1;\n',
    'type T = (keyof: unknown) => keyof is number | string;\nconst sentinel = 1;\n',
    'type T = (infer: unknown) => infer is string;\nconst sentinel = 1;\n',
    'type T = (infer: unknown) => infer is string[];\nconst sentinel = 1;\n',
    'type T = (infer: unknown) => infer is number | string;\nconst sentinel = 1;\n',
    'type T = (readonly: unknown) => readonly.value is string;\nconst sentinel = 1;\n',
    'type T = (abstract: unknown) => abstract is;\nconst sentinel = 1;\n',
    'interface I { (undefined: unknown): undefined is; }\nconst sentinel = 1;\n',
    'interface I { (undefined: unknown): undefined.value is string; }\nconst sentinel = 1;\n',
    'interface I { (undefined: unknown): undefined ? string : number; }\nconst sentinel = 1;\n',
    'interface I { (keyof: unknown): keyof.value is string; }\nconst sentinel = 1;\n',
    'interface I { (infer: unknown): infer.value is string; }\nconst sentinel = 1;\n',
    'interface I { (readonly: unknown): readonly.value is string; }\nconst sentinel = 1;\n',
    'interface I { (abstract: unknown): abstract is; }\nconst sentinel = 1;\n',
  ])('retains editor recovery and sentinel through trivia edits: %s', (original) => {
    const parser = new Parser().setLanguage(language);
    let tree: Tree | undefined;
    let source = original;
    const start = source.indexOf(': unknown') + ': unknown'.length;
    const insertion = ' /* edited parameter */';
    try {
      tree = parser.parse(source)!;
      expect(tree.rootNode.hasError).toBe(true);
      const initialTree = tree.rootNode.toString();
      const initialCaptures = configured.map((q) => captureSnapshot(q, tree!));
      for (const inserted of [true, false]) {
        const next = inserted ? original.slice(0, start) + insertion + original.slice(start) : original;
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex: start,
            oldEndIndex: start + (inserted ? 0 : insertion.length),
            newEndIndex: start + (inserted ? insertion.length : 0),
            startPosition: position(source, start),
            oldEndPosition: position(source, start + (inserted ? 0 : insertion.length)),
            newEndPosition: position(next, start + (inserted ? insertion.length : 0)),
          }),
          (incremental, fresh) => {
            for (const current of [incremental, fresh]) {
              const sentinel = current.rootNode
                .descendantsOfType('lexical_declaration')
                .find((node) => node.text === 'const sentinel = 1;');
              expect(sentinel?.startIndex).toBe(next.indexOf('const sentinel = 1;'));
              expect(sentinel?.endIndex).toBe(next.indexOf('const sentinel = 1;') + 'const sentinel = 1;'.length);
            }
            for (const q of configured) expect(captureSnapshot(q, incremental)).toEqual(captureSnapshot(q, fresh));
          },
          true
        );
        previous.delete();
        source = next;
      }
      expect(source).toBe(original);
      expect(tree.rootNode.toString()).toBe(initialTree);
      expect(configured.map((q) => captureSnapshot(q, tree!))).toEqual(initialCaptures);
    } finally {
      tree?.delete();
      parser.delete();
    }
  });
  test.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])('retains is-named predicates through edits (asserts: %s, function type: %s)', (asserts, functionType) => {
    const parser = new Parser().setLanguage(language);
    const original = `${functionType ? 'type F = (is: unknown) =>' : 'declare function f(is: unknown):'} ${asserts ? 'asserts ' : ''}is is string;\n`;
    const start = original.lastIndexOf('is is string');
    let source = original;
    let tree: Tree | undefined;
    try {
      tree = parser.parse(source)!;
      checkPredicate(tree, source, 'is');
      for (const [before, after] of [
        ['is', 'parameter'],
        ['parameter', 'is'],
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
            for (const current of [incremental, fresh]) checkPredicate(current, next, after!);
            for (const q of configured) expect(captureSnapshot(q, incremental)).toEqual(captureSnapshot(q, fresh));
          }
        );
        previous.delete();
        source = next;
      }
      expect(source).toBe(original);
      function checkPredicate(current: Tree, text: string, name: string): void {
        expect(current.rootNode.hasError).toBe(false);
        const predicate = current.rootNode.descendantsOfType('type_predicate')[0]!;
        expect(predicate.childForFieldName('name')?.type).toBe('identifier');
        expect(predicate.childForFieldName('name')?.text).toBe(name);
        expect(predicate.childForFieldName('name')?.startIndex).toBe(start);
        expect(predicate.childForFieldName('name')?.endIndex).toBe(start + name.length);
        expect(predicate.childForFieldName('type')?.text).toBe('string');
        expect(predicate.childForFieldName('type')?.startIndex).toBe(text.indexOf('string'));
        expect(current.rootNode.descendantsOfType('asserts_annotation')).toHaveLength(asserts && !functionType ? 1 : 0);
        expect(current.rootNode.descendantsOfType('type_predicate_annotation')).toHaveLength(
          !asserts && !functionType ? 1 : 0
        );
      }
    } finally {
      tree?.delete();
      parser.delete();
    }
  });
  test.each([
    'function f(infer: unknown): infer is%s { return true; }',
    'class C { m(infer: unknown): infer is%s { return true; } }',
  ])('retains infer return-type recovery through predicate edits: %s', (template) => {
    const parser = new Parser().setLanguage(language);
    let tree: Tree | undefined;
    let source = template.replace('%s', '');
    const start = source.indexOf('is {') + 2;
    try {
      tree = parser.parse(source)!;
      checkInferReturn(tree, false);
      for (const predicate of [true, false]) {
        const next = template.replace('%s', predicate ? ' string' : '');
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex: start,
            oldEndIndex: start + (predicate ? 0 : 7),
            newEndIndex: start + (predicate ? 7 : 0),
            startPosition: position(source, start),
            oldEndPosition: position(source, start + (predicate ? 0 : 7)),
            newEndPosition: position(next, start + (predicate ? 7 : 0)),
          }),
          (incremental, fresh) => {
            checkInferReturn(incremental, predicate);
            checkInferReturn(fresh, predicate);
            for (const configuredQuery of configured)
              expect(
                configuredQuery
                  .captures(incremental.rootNode)
                  .map(({ name, node }) => [name, node.toString(), node.startIndex, node.endIndex])
              ).toEqual(
                configuredQuery
                  .captures(fresh.rootNode)
                  .map(({ name, node }) => [name, node.toString(), node.startIndex, node.endIndex])
              );
          }
        );
        previous.delete();
        source = next;
      }
    } finally {
      tree?.delete();
      parser.delete();
    }
  });
  test.each(['undefined', 'keyof', 'infer', 'readonly', 'abstract', 'asserts'])(
    'preserves %s predicate ownership through edits',
    (word) => {
      const parser = new Parser().setLanguage(language);
      let tree: Tree | undefined;
      let source = Source;
      try {
        tree = parser.parse(source)!;
        check(tree, source);
        const start = source.indexOf(`${word} is string`);
        expect(start).toBeGreaterThanOrEqual(0);
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
              for (const configuredQuery of configured) {
                const captures = (current: Tree): unknown[] =>
                  configuredQuery
                    .captures(current.rootNode)
                    .map(({ name, node }) => [
                      name,
                      node.type,
                      node.text,
                      node.startIndex,
                      node.endIndex,
                      node.startPosition,
                      node.endPosition,
                    ]);
                expect(captures(incremental)).toEqual(captures(fresh));
              }
            }
          );
          previous.delete();
          source = next;
        }
        expect(source).toBe(Source);
        function check(current: Tree, text: string): void {
          const reference = ts.createSourceFile('predicates.ts', text, ts.ScriptTarget.Latest, true);
          const expected: [string, string, number, number][] = [];
          const visit = (node: ts.Node): void => {
            if (ts.isTypePredicateNode(node) && ts.isIdentifier(node.parameterName) && node.type) {
              expected.push([
                'name',
                node.parameterName.getText(reference),
                node.parameterName.getStart(reference),
                node.parameterName.getEnd(),
              ]);
              expected.push(['type', node.type.getText(reference), node.type.getStart(reference), node.type.getEnd()]);
            }
            ts.forEachChild(node, visit);
          };
          visit(reference);
          expect(current.rootNode.hasError).toBe(false);
          expect(
            query!.captures(current.rootNode).map(({ name, node }) => [name, node.text, node.startIndex, node.endIndex])
          ).toEqual(expected);
        }
      } finally {
        tree?.delete();
        parser.delete();
      }
    }
  );
});

function checkInferReturn(current: Tree, predicate: boolean): void {
  expect(current.rootNode.hasError).toBe(false);
  const owner = current.rootNode.descendantsOfType(['function_declaration', 'method_definition'])[0]!;
  expect(owner.childForFieldName('body')?.text).toBe('{ return true; }');
  expect(owner.childForFieldName('return_type')?.type).toBe(
    predicate ? 'type_predicate_annotation' : 'type_annotation'
  );
  expect(current.rootNode.descendantsOfType('infer_type').map((node) => node.text)).toEqual(
    predicate ? [] : ['infer is']
  );
}

function captureSnapshot(query: Query, current: Tree): unknown[] {
  return query
    .captures(current.rootNode)
    .map(({ name, node }) => [
      name,
      node.type,
      node.text,
      node.startIndex,
      node.endIndex,
      node.startPosition,
      node.endPosition,
    ]);
}
