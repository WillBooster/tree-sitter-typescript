import fs from 'node:fs';
import path from 'node:path';

import { Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { expectNodeRanges } from '../helpers/nodeRanges.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

const Source = fs.readFileSync(path.join(import.meta.dirname, '../fixtures/plainPredicateNames.ts'), 'utf8');

describe.each(['typescript', 'tsx'])('%s plain predicate names', (dialect) => {
  let language: Awaited<ReturnType<typeof loadCurrentWasmBuild>>;
  let query: Query | undefined;
  beforeAll(async () => {
    await Parser.init();
    language = await loadCurrentWasmBuild(dialect);
    query = new Query(language, '(type_predicate name: (identifier) @name type: (_) @type)');
  }, 30_000);
  afterAll(() => query?.delete());
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
    'type T = (readonly: unknown) => readonly.value is string;\nconst sentinel = 1;\n',
    'type T = (abstract: unknown) => abstract is;\nconst sentinel = 1;\n',
    'interface I { (undefined: unknown): undefined is; }\nconst sentinel = 1;\n',
    'interface I { (undefined: unknown): undefined.value is string; }\nconst sentinel = 1;\n',
    'interface I { (undefined: unknown): undefined ? string : number; }\nconst sentinel = 1;\n',
    'interface I { (keyof: unknown): keyof.value is string; }\nconst sentinel = 1;\n',
    'interface I { (infer: unknown): infer.value is string; }\nconst sentinel = 1;\n',
    'interface I { (readonly: unknown): readonly.value is string; }\nconst sentinel = 1;\n',
    'interface I { (abstract: unknown): abstract is; }\nconst sentinel = 1;\n',
  ])('retains error ranges with and without parameter trivia: %s', (original) => {
    const parser = new Parser().setLanguage(language);
    const start = original.indexOf(': unknown') + ': unknown'.length;
    try {
      for (const source of [original, original.slice(0, start) + ' /* edited parameter */' + original.slice(start)]) {
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError).toBe(true);
          expectNodeRanges(tree.rootNode, source);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });
  test.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])('retains is-named and renamed predicates (asserts: %s, function type: %s)', (asserts, functionType) => {
    const parser = new Parser().setLanguage(language);
    const original = `${functionType ? 'type F = (is: unknown) =>' : 'declare function f(is: unknown):'} ${asserts ? 'asserts ' : ''}is is string;\n`;
    const start = original.lastIndexOf('is is string');
    try {
      for (const name of ['is', 'parameter']) {
        const source = original.slice(0, start) + name + original.slice(start + 'is'.length);
        const tree = parser.parse(source)!;
        try {
          checkPredicate(tree, source, name);
        } finally {
          tree.delete();
        }
      }
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
      parser.delete();
    }
  });
  test.each([
    'function f(infer: unknown): infer is%s { return true; }',
    'class C { m(infer: unknown): infer is%s { return true; } }',
  ])('retains infer return-type recovery with and without predicate types: %s', (template) => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const predicate of [false, true]) {
        const tree = parser.parse(template.replace('%s', predicate ? ' string' : ''))!;
        try {
          checkInferReturn(tree, predicate);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });
  test.each(dialect === 'tsx' ? ['tuple', 'JSX'] : ['tuple'])('preserves %s name fields with renamed names', (role) => {
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
    const tuples = new Query(language, '(tuple_type) @tuple');
    const original =
      role === 'tuple'
        ? Source
        : `
      namespace JSX { export interface Element {} export interface IntrinsicElements { is: { value?: string }; parameter: { value?: string }; 'is:label': {}; } }
      declare namespace is { function Pane(props: {}): JSX.Element; }
      const value = <is value="value"><is.Pane /><is:label /></is>;
      const sentinel = 1;`;
    try {
      for (const source of [
        original,
        ...(role === 'tuple' ? ['[is: string]'] : ['<is value=', '</is>']).map((marker) => {
          const start = original.indexOf(marker) + (marker.startsWith('</') ? 2 : 1);
          return original.slice(0, start) + 'parameter' + original.slice(start + 'is'.length);
        }),
      ]) {
        const tree = parser.parse(source)!;
        try {
          check(tree, source);
        } finally {
          tree.delete();
        }
      }
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
      names.delete();
      tuples.delete();
      parser.delete();
    }
  });
  if (dialect === 'tsx')
    test('retains incomplete closing JSX names while completing and renaming tags', () => {
      const parser = new Parser().setLanguage(language);
      const sources = [
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
        for (const source of sources) {
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(!source.endsWith('>;'));
            const name = source.slice(source.lastIndexOf('</') + 2).match(/island|is--|is-|is/)![0];
            const closingStart = source.lastIndexOf(name);
            const leaf = tree.rootNode.descendantsOfType('identifier').find((node) => node.startIndex === closingStart);
            expect(leaf?.text).toBe(name);
            expect(leaf?.endIndex).toBe(closingStart + name.length);
          } finally {
            tree.delete();
          }
        }
      } finally {
        parser.delete();
      }
    });
  test.each(['qualified type', 'undefined', 'keyof', 'infer', 'readonly', 'abstract', 'asserts'])(
    'preserves qualified type and bare assertion roles for %s and a renamed parameter',
    (role) => {
      const parser = new Parser().setLanguage(language);
      const assertions = new Query(language, '(asserts_annotation (asserts (identifier) @name))');
      const qualified = new Query(language, '(nested_type_identifier) @qualified');
      const before = role === 'qualified type' ? 'is' : role;
      const marker = role === 'qualified type' ? 'value: ' : 'asserts ';
      const start = Source.indexOf(`${marker}${before}${role === 'qualified type' ? '.NS' : ';'}`) + marker.length;
      try {
        for (const source of [Source, Source.slice(0, start) + 'parameter' + Source.slice(start + before.length)]) {
          const tree = parser.parse(source)!;
          try {
            check(tree, source);
          } finally {
            tree.delete();
          }
        }
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
        assertions.delete();
        qualified.delete();
        parser.delete();
      }
    }
  );
  test('preserves bare is assertion recovery with renamed names and trivia', () => {
    const parser = new Parser().setLanguage(language);
    const query = new Query(language, '(asserts_annotation (asserts (identifier) @name))');
    try {
      for (const [name, replacement] of [
        ['is', 'is'],
        ['longerName', 'longerName /* assertion */'],
      ] as const) {
        const source = `declare function f(is: unknown): asserts ${replacement}; const sentinel = 1;`;
        const tree = parser.parse(source)!;
        try {
          check(tree, source, name);
        } finally {
          tree.delete();
        }
      }
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
      query.delete();
      parser.delete();
    }
  });
  test.each(['undefined', 'keyof', 'infer', 'readonly', 'abstract', 'asserts'])(
    'preserves %s predicate ownership and a renamed parameter',
    (word) => {
      const parser = new Parser().setLanguage(language);
      try {
        const start = Source.indexOf(`${word} is string`);
        expect(start).toBeGreaterThanOrEqual(0);
        for (const source of [Source, Source.slice(0, start) + 'parameter' + Source.slice(start + word.length)]) {
          const tree = parser.parse(source)!;
          try {
            check(tree, source);
          } finally {
            tree.delete();
          }
        }
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
