import { Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

import { loadCurrentWasmBuild } from './wasmBuild';

await Parser.init();

for (const dialect of ['typescript', 'tsx']) {
  const language = await loadCurrentWasmBuild(dialect);

  test(`${dialect} retains class static index signatures and their modifiers`, () => {
    const parser = new Parser().setLanguage(language);
    const tree = parser.parse(`class Values {
  static [key: string]: number;
  static [index: number]: number;
  static readonly [name: \`value-\${string}\`]: number;
  [key: symbol]: string;
  static value = 3;
  static ["computed"]: number = 4;
}
interface ValuesByKey { readonly [key: string]: number; }
type ValuesByIndex = { [key: number]: number };
`)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      const signatures = tree.rootNode.descendantsOfType('index_signature');
      expect(signatures.map((node) => node.childForFieldName('name')?.text)).toEqual([
        'key',
        'index',
        'name',
        'key',
        'key',
        'key',
      ]);
      expect(signatures.map((node) => node.childForFieldName('index_type')?.text)).toEqual([
        'string',
        'number',
        '`value-${string}`',
        'symbol',
        'string',
        'number',
      ]);
      expect(signatures.map((node) => node.children.some((child) => child.type === 'static'))).toEqual([
        true,
        true,
        true,
        false,
        false,
        false,
      ]);
      expect(signatures.map((node) => node.children.some((child) => child.type === 'readonly'))).toEqual([
        false,
        false,
        true,
        false,
        true,
        false,
      ]);
      expect(
        tree.rootNode.descendantsOfType('field_definition').map((node) => node.childForFieldName('name')?.text)
      ).toEqual(['value', '["computed"]']);
    } finally {
      tree.delete();
      parser.delete();
    }
  });
}
