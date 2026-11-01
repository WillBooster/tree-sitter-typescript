import { Parser } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { loadCurrentWasmBuild } from './wasmBuild.js';

type Range = [number, number, string];
const Parameters = [
  '[[x = /]/]]',
  '[[x = f(/]/)]]',
  String.raw`[[x = /[()[\]{}]/]]`,
  String.raw`[[x = f(/[/\]]/, /\]/g)]]`,
  '[[{value: x = /]/}]]',
  '[{value: [x = /}/]}]',
  '[[x = () => /]/]]',
  '[[x = function () { return /]/; }]]',
  '[[x = value / divisor], y = other / divisor]',
  '[[x = object.return / divisor], y = other / divisor]',
  '[[x = object?.throw / divisor], y = other / divisor]',
  '[[x = count++ / divisor], y = other / divisor]',
  '[[x = count-- / divisor], y = other / divisor]',
  '[[x = value! / divisor], y = other / divisor]',
  '[[x = 3.4 / divisor], y = other / divisor]',
  '[[x = value < /word/ / divisor]]',
  '[[x = foo<T> / divisor]]',
  '[[x = (value / divisor) + /]/.test(text)]]',
  '[[x = /* ] */ /]/]]',
  '[[x = // ]\n/]/]]',
];
const InvalidTypes = ['([[x = /]/]: T) => A', '([[x = /unterminated]]: T) => A', '([[x = /[abc/]]: T) => A'];
const TsxParameters = [
  '[[x = <div></div>]]',
  '[[x = <div><span /></div>]]',
  '[[x = <div attribute={a / b}></div> / divisor]]',
  '[[x = /]/, y = <div></div>]]',
  '[[x = ((<T,>(value: T) => value)(input)) < /word/ / divisor]]',
];
const TypeControls = [
  '([<T = U>() => T])',
  '({[x = y]: T})',
  '({[x = f(/]/)]: T})',
  '([{[x = y]: T}, <T = U>() => T])',
];

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves nested binding regex defaults and type boundaries in ${dialect}`, async () => {
    await Parser.init();
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      const parameters = [...Parameters, ...(dialect === 'tsx' ? TsxParameters : [])];
      const types = [
        ...parameters.map((parameter) => `(${parameter}: T) => A`),
        ...TypeControls,
        ...(dialect === 'tsx' ? ['([[x = <div></div>]]: T) => A // /'] : []),
      ];
      const sources = [
        ...types.map((type) => `value as ${type};\nconst following = 1;`),
        ...['await', 'yield'].map(
          (name) =>
            `function ordinary() { value as ([[x = ${name} / divisor / second]]: T) => A; }\nconst following = 1;`
        ),
        'class C { #return = 1; method() { return value as ([[x = this.#return / divisor], y = other / divisor]: T) => A; } }\nconst following = 1;',
      ];
      for (const source of sources) {
        const fileName = dialect === 'tsx' ? 'binding.tsx' : 'binding.ts';
        const reference = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
        expect(ts.transpileModule(source, { fileName, reportDiagnostics: true }).diagnostics ?? [], source).toEqual([]);
        const expected: Record<string, Range[]> = {
          array_pattern: [],
          object_pattern: [],
          regex: [],
          function_type: [],
          binary_expression: [],
        };
        const collect = (node: ts.Node): void => {
          const kind = ts.isArrayBindingPattern(node)
            ? 'array_pattern'
            : ts.isObjectBindingPattern(node)
              ? 'object_pattern'
              : ts.isRegularExpressionLiteral(node)
                ? 'regex'
                : ts.isFunctionTypeNode(node)
                  ? 'function_type'
                  : undefined;
          if (kind) expected[kind]!.push([node.getStart(reference), node.end, node.getText(reference)]);
          if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind !== ts.SyntaxKind.EqualsToken &&
            node.operatorToken.kind !== ts.SyntaxKind.CommaToken
          )
            expected.binary_expression!.push([node.getStart(reference), node.end, node.getText(reference)]);
          ts.forEachChild(node, collect);
        };
        collect(reference);
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(tree.rootNode.lastNamedChild!.text, source).toBe('const following = 1;');
          for (const [kind, ranges] of Object.entries(expected)) {
            expect(
              tree.rootNode.descendantsOfType(kind).map((node) => [node.startIndex, node.endIndex, node.text]),
              `${kind}: ${source}`
            ).toEqual(ranges);
          }
        } finally {
          tree.delete();
        }
      }
      for (const type of InvalidTypes) {
        const source = `value as ${type};`;
        const fileName = dialect === 'tsx' ? 'binding.tsx' : 'binding.ts';
        expect(
          ts.transpileModule(source, { fileName, reportDiagnostics: true }).diagnostics?.length,
          source
        ).toBeGreaterThan(0);
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
