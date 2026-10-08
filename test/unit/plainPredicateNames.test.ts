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
  test.each(dialect === 'tsx' ? ['tuple', 'JSX'] : ['tuple'])(
    'preserves %s name fields and queries through edits',
    (role) => {
      const parser = new Parser().setLanguage(language);
      const tupleQuery = `
      (tuple_type (required_parameter name: (identifier) @name))
      (tuple_type (optional_parameter name: (identifier) @name))
      (tuple_type (required_parameter name: (rest_pattern (identifier) @name)))
    `;
      const jsxQuery = `
      (jsx_opening_element name: (_) @name)
      (jsx_closing_element name: (_) @name)
      (jsx_self_closing_element name: (_) @name)
    `;
      const names = new Query(language, role === 'tuple' ? tupleQuery : jsxQuery);
      const tuples = new Query(language, '(primary_type/tuple_type) @tuple');
      const original =
        role === 'tuple'
          ? Source
          : `
      namespace JSX { export interface Element {} export interface IntrinsicElements { is: { value?: string }; parameter: { value?: string }; 'is:label': {}; } }
      declare namespace is { function Pane(props: {}): JSX.Element; }
      const value = <is value="value"><is.Pane /><is:label /></is>;
      const sentinel = 1;`;
      let source = original;
      let tree: Tree | undefined;
      try {
        tree = parser.parse(source)!;
        check(tree, source);
        for (const marker of role === 'tuple' ? ['[is: string]'] : ['<is value=', '</is>']) {
          const start = source.indexOf(marker) + (marker.startsWith('</') ? 2 : 1);
          for (const [oldName, newName] of [
            ['is', 'parameter'],
            ['parameter', 'is'],
          ]) {
            const next = source.slice(0, start) + newName + source.slice(start + oldName!.length);
            const previous = tree;
            tree = compareEditedTree(
              parser,
              previous,
              next,
              new Edit({
                startIndex: start,
                oldEndIndex: start + oldName!.length,
                newEndIndex: start + newName!.length,
                startPosition: position(source, start),
                oldEndPosition: position(source, start + oldName!.length),
                newEndPosition: position(next, start + newName!.length),
              }),
              (incremental, fresh) => {
                check(incremental, next);
                check(fresh, next);
                for (const q of configured) expect(captureSnapshot(q, incremental)).toEqual(captureSnapshot(q, fresh));
              }
            );
            previous.delete();
            source = next;
          }
        }
        expect(source).toBe(original);
        function check(current: Tree, text: string): void {
          const reference = ts.createSourceFile(
            role === 'JSX' ? 'names.tsx' : 'names.ts',
            text,
            ts.ScriptTarget.Latest,
            true,
            role === 'JSX' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
          );
          const expected: [string, string, number, number][] = [];
          const expectedTypes: [number, number][] = [];
          const visit = (node: ts.Node): void => {
            const name =
              role === 'tuple' && ts.isNamedTupleMember(node)
                ? node.name
                : role === 'JSX' &&
                    (ts.isJsxOpeningElement(node) || ts.isJsxClosingElement(node) || ts.isJsxSelfClosingElement(node))
                  ? node.tagName
                  : undefined;
            if (name) {
              const type = ts.isPropertyAccessExpression(name)
                ? 'member_expression'
                : ts.isJsxNamespacedName(name)
                  ? 'jsx_namespace_name'
                  : 'identifier';
              expected.push([name.getText(reference), type, name.getStart(reference), name.getEnd()]);
            }
            if (ts.isTupleTypeNode(node)) expectedTypes.push([node.getStart(reference), node.getEnd()]);
            ts.forEachChild(node, visit);
          };
          visit(reference);
          expect(current.rootNode.hasError).toBe(false);
          expect(
            names.captures(current.rootNode).map(({ node }) => [node.text, node.type, node.startIndex, node.endIndex])
          ).toEqual(expected);
          expect(tuples.captures(current.rootNode).map(({ node }) => [node.startIndex, node.endIndex])).toEqual(
            expectedTypes
          );
          if (role === 'JSX') expect(current.rootNode.namedChildren.at(-1)?.text).toBe('const sentinel = 1;');
        }
      } finally {
        tree?.delete();
        names.delete();
        tuples.delete();
        parser.delete();
      }
    }
  );
  if (dialect === 'tsx')
    test('retains incomplete closing JSX names while completing and renaming tags', () => {
      const parser = new Parser().setLanguage(language);
      let tree: Tree | undefined;
      let source = 'const value=<is></is>;';
      const stages = [
        'const value=<is></is',
        'const value=<is></is ',
        'const value=<is></is:',
        'const value=<is></is.',
        'const value=<is></is.1',
        'const value=<is></is:1',
        'const value=<is></is.:',
        'const value=<is></is:.',
        'const value=<is></is.?',
        'const value=<is></is:?',
        'const value=<is></is..',
        'const value=<is></is::',
        'const value=<is></is. /*',
        'const value=<is></is: /*',
        'const value=<is></is. /* c */?',
        'const value=<is></is: /* c */?',
        'const value=<is></is\n',
        'const value=<is>{x}</is',
        'const value=<is a={x}></is',
        'const value=<is a={x}></is /* closing */',
        'const value=<is a={x}></is /*',
        'const value=<is a={x}></is /* closing',
        'const value=<is a={x}></is /',
        'const value=<is a={x}></is?',
        'const value=<is a={x}></is \u200D',
        'const value=<is a={x}></is // closing\n',
        'const value=<is a={x}></island',
        'const value=<is a={x}></island>;',
        'const value=<is a={x}></is>;',
        'const value=<is></<!-- preceding -->\nis',
        'const value=<is></<!-- preceding -->\nis>;',
        'const value=<is></--> preceding\nis',
        'const value=<is></--> preceding\nis>;',
        'const value=<is-></is-',
        'const value=<is-></is->;',
        'const value=<is--></is--',
        'const value=<is--></is-->;',
        'const value=<is></is>;',
      ];
      try {
        tree = parser.parse(source)!;
        for (const next of stages) {
          let start = 0;
          while (source[start] === next[start] && start < Math.min(source.length, next.length)) start++;
          let oldEnd = source.length;
          let newEnd = next.length;
          while (oldEnd > start && newEnd > start && source[oldEnd - 1] === next[newEnd - 1]) {
            oldEnd--;
            newEnd--;
          }
          const previous = tree;
          tree = compareEditedTree(
            parser,
            previous,
            next,
            new Edit({
              startIndex: start,
              oldEndIndex: oldEnd,
              newEndIndex: newEnd,
              startPosition: position(source, start),
              oldEndPosition: position(source, oldEnd),
              newEndPosition: position(next, newEnd),
            }),
            (incremental, fresh) => {
              for (const current of [incremental, fresh]) {
                expect(current.rootNode.hasError).toBe(!next.endsWith('>;'));
                const name = next.slice(next.lastIndexOf('</') + 2).match(/island|is--|is-|is/)![0];
                const closingStart = next.lastIndexOf(name);
                const leaf = current.rootNode
                  .descendantsOfType('identifier')
                  .find((node) => node.startIndex === closingStart);
                expect(leaf?.text).toBe(name);
                expect(leaf?.endIndex).toBe(closingStart + name.length);
                expect(
                  configured[0]!
                    .captures(current.rootNode)
                    .some(
                      ({ name: capture, node }) =>
                        capture === 'variable' &&
                        node.startIndex === closingStart &&
                        node.endIndex === closingStart + name.length
                    )
                ).toBe(true);
                expect(
                  configured[2]!
                    .captures(current.rootNode)
                    .some(
                      ({ name: capture, node }) =>
                        capture === 'local.reference' &&
                        node.startIndex === closingStart &&
                        node.endIndex === closingStart + name.length
                    )
                ).toBe(true);
              }
              for (const q of configured) expect(captureSnapshot(q, incremental)).toEqual(captureSnapshot(q, fresh));
            },
            true
          );
          previous.delete();
          source = next;
        }
      } finally {
        tree?.delete();
        parser.delete();
      }
    });
  test.each(['qualified type', 'undefined', 'keyof', 'infer', 'readonly', 'abstract', 'asserts'])(
    'preserves qualified type and bare assertion roles through %s edits',
    (role) => {
      const parser = new Parser().setLanguage(language);
      const assertions = new Query(language, '(asserts_annotation (asserts (identifier) @name))');
      const qualified = new Query(language, '(primary_type/nested_type_identifier) @qualified');
      const before = role === 'qualified type' ? 'is' : role;
      const marker = role === 'qualified type' ? 'value: ' : 'asserts ';
      const start = Source.indexOf(`${marker}${before}${role === 'qualified type' ? '.NS' : ';'}`) + marker.length;
      let tree: Tree | undefined;
      let source = Source;
      try {
        tree = parser.parse(source)!;
        check(tree, source);
        for (const [oldName, newName] of [
          [before, 'parameter'],
          ['parameter', before],
        ]) {
          const next = source.slice(0, start) + newName + source.slice(start + oldName!.length);
          const previous = tree;
          tree = compareEditedTree(
            parser,
            previous,
            next,
            new Edit({
              startIndex: start,
              oldEndIndex: start + oldName!.length,
              newEndIndex: start + newName!.length,
              startPosition: position(source, start),
              oldEndPosition: position(source, start + oldName!.length),
              newEndPosition: position(next, start + newName!.length),
            }),
            (incremental, fresh) => {
              check(incremental, next);
              check(fresh, next);
              for (const q of configured) expect(captureSnapshot(q, incremental)).toEqual(captureSnapshot(q, fresh));
            }
          );
          previous.delete();
          source = next;
        }
        expect(source).toBe(Source);
        function check(current: Tree, text: string): void {
          const reference = ts.createSourceFile('predicates.ts', text, ts.ScriptTarget.Latest, true);
          const expected: [string, number, number][] = [];
          let referenceType: ts.TypeNode | undefined;
          const visit = (node: ts.Node): void => {
            if (ts.isTypePredicateNode(node) && node.assertsModifier && !node.type)
              expected.push([
                node.parameterName.getText(reference),
                node.parameterName.getStart(reference),
                node.parameterName.getEnd(),
              ]);
            if (ts.isVariableDeclaration(node) && node.name.getText(reference) === 'value') referenceType = node.type;
            ts.forEachChild(node, visit);
          };
          visit(reference);
          expect(current.rootNode.hasError).toBe(false);
          expect(
            assertions.captures(current.rootNode).map(({ node }) => [node.text, node.startIndex, node.endIndex])
          ).toEqual(expected);
          const capture = qualified
            .captures(current.rootNode)
            .find(({ node }) => node.startIndex === referenceType!.getStart(reference))!;
          expect(capture.node.text).toBe(referenceType!.getText(reference));
          expect(capture.node.endIndex).toBe(referenceType!.getEnd());
          expect(capture.node.childForFieldName('module')?.type).toBe('identifier');
          expect(capture.node.childForFieldName('name')?.type).toBe('type_identifier');
        }
      } finally {
        tree?.delete();
        assertions.delete();
        qualified.delete();
        parser.delete();
      }
    }
  );
  test('preserves bare is assertion recovery through name and trivia edits', () => {
    const parser = new Parser().setLanguage(language);
    const query = new Query(language, '(asserts_annotation (asserts (identifier) @name))');
    const original = 'declare function f(is: unknown): asserts is; const sentinel = 1;';
    let source = original;
    let tree: Tree | undefined;
    try {
      tree = parser.parse(source)!;
      check(tree, source, 'is');
      for (const name of ['longerName', 'is']) {
        const start = source.indexOf('asserts ') + 'asserts '.length;
        const end = source.indexOf(';', start);
        const replacement = name === 'is' ? name : `${name} /* assertion */`;
        const next = source.slice(0, start) + replacement + source.slice(end);
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex: start,
            oldEndIndex: end,
            newEndIndex: start + replacement.length,
            startPosition: position(source, start),
            oldEndPosition: position(source, end),
            newEndPosition: position(next, start + replacement.length),
          }),
          (incremental, fresh) => {
            check(incremental, next, name);
            check(fresh, next, name);
            for (const q of configured) expect(captureSnapshot(q, incremental)).toEqual(captureSnapshot(q, fresh));
          }
        );
        previous.delete();
        source = next;
      }
      expect(source).toBe(original);
      function check(current: Tree, text: string, name: string): void {
        expect(current.rootNode.hasError, text).toBe(false);
        const matches = query.captures(current.rootNode);
        expect(matches).toHaveLength(1);
        const node = matches[0]!.node;
        expect(node.type).toBe('identifier');
        expect(node.text).toBe(name);
        const start = text.indexOf('asserts ') + 'asserts '.length;
        expect(node.startIndex).toBe(start);
        expect(node.endIndex).toBe(start + name.length);
        expect(current.rootNode.namedChildren.at(-1)?.text).toBe('const sentinel = 1;');
      }
    } finally {
      tree?.delete();
      query.delete();
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
