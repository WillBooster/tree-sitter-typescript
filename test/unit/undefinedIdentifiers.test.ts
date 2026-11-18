import { Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

import { loadCurrentWasmBuild } from './wasmBuild';

await Parser.init();

for (const dialect of ['typescript', 'tsx']) {
  const language = await loadCurrentWasmBuild(dialect);

  test(`${dialect} reads and writes undefined as an ordinary binding name`, () => {
    const parser = new Parser().setLanguage(language);
    const source = String.raw`function f(undefined: number) {
  undefined += 1;
  return undefined;
}
const g = (undefined: number | string) => typeof undefined === 'number' ? undefined + 1 : undefined.length;
{ let undefined = 3; undefined++; }
function h({ value: undefined }: { value: number }) { return undefined; }
function escaped(undefin\u0065d: number) { return undefin\u0065d; }
const missing: undefined = undefined;
type Missing = undefined;
function query(undefined: number) { type Value = typeof undefined; return undefined; }
`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.descendantsOfType('undefined').map((node) => node.parent?.type)).toEqual([
        'literal_type',
        'literal_type',
      ]);
      expect(tree.rootNode.descendantsOfType('identifier').filter((node) => node.text === 'undefined')).toHaveLength(
        15
      );
      const parameters = tree.rootNode.descendantsOfType('required_parameter');
      expect(
        parameters
          .filter((node) => node.childForFieldName('pattern')?.text === 'undefined')
          .map((node) => node.childForFieldName('pattern')?.type)
      ).toEqual(['identifier', 'identifier', 'identifier']);
      const queries = tree.rootNode.descendantsOfType('type_query');
      expect(queries.map((node) => node.namedChildren[0]?.type)).toEqual(['identifier']);
    } finally {
      tree.delete();
      parser.delete();
    }
  });
}
