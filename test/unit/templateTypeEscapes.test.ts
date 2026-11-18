import { Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

import { loadCurrentWasmBuild } from './wasmBuild';

const ValidEscapes = [
  String.raw`\n`,
  String.raw`\r`,
  String.raw`\t`,
  String.raw`\0`,
  String.raw`\q`,
  String.raw`\x61`,
  String.raw`\u0061`,
  String.raw`\u{1f600}`,
  '\\`',
  '\\${literal}',
  String.raw`\\`,
  '\\\n',
  '\\\r\n',
];
const RawEscapes = [
  String.raw`\n\u{110000}`,
  String.raw`\u{110000}`,
  String.raw`\u{ffffffffffffffff}`,
  String.raw`\u{}`,
  String.raw`\u{xyz}`,
  String.raw`\u12`,
  String.raw`\u`,
  String.raw`\x1`,
  String.raw`\x`,
  String.raw`\123`,
  String.raw`\8`,
  String.raw`\09`,
];

await Parser.init();

for (const dialect of ['typescript', 'tsx']) {
  const language = await loadCurrentWasmBuild(dialect);

  test.each([...ValidEscapes, ...RawEscapes])(`${dialect} retains no-substitution type escape %j`, (escape) => {
    const parser = new Parser().setLanguage(language);
    const source = 'type Escape = `pre' + escape + 'post`; const after = 1;';
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.namedChildren.map((node) => node.type)).toEqual([
        'type_alias_declaration',
        'lexical_declaration',
      ]);
      const [template] = tree.rootNode.descendantsOfType('template_literal_type');
      expect(template?.namedChildren.map((node) => node.text).join('')).toBe('pre' + escape + 'post');
      expect(template?.descendantsOfType('template_type')).toHaveLength(0);
      expect(template?.descendantsOfType('escape_sequence').length).toBeGreaterThan(0);
    } finally {
      tree.delete();
      parser.delete();
    }
  });

  test.each(ValidEscapes)(`${dialect} keeps substitution boundaries around valid type escape %j`, (escape) => {
    const parser = new Parser().setLanguage(language);
    const source = 'type Escape<T extends string> = `pre' + escape + '${T}post`; const after = 1;';
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      const [template] = tree.rootNode.descendantsOfType('template_literal_type');
      expect(template?.descendantsOfType('template_type').map((node) => node.text)).toEqual(['${T}']);
      expect(
        template?.namedChildren
          .filter((node) => node.type !== 'template_type')
          .map((node) => node.text)
          .join('')
      ).toBe('pre' + escape + 'post');
    } finally {
      tree.delete();
      parser.delete();
    }
  });

  test.each(RawEscapes)(
    `${dialect} rejects raw-only escape %j around type substitutions and in expressions`,
    (escape) => {
      const parser = new Parser().setLanguage(language);
      try {
        for (const source of [
          'type Escape = `' + escape + '${string}`;',
          'type Escape = `${string}' + escape + '${number}`;',
          'type Escape = `${string}' + escape + '`;',
          'const value = `' + escape + '`;',
        ]) {
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError).toBe(true);
          } finally {
            tree.delete();
          }
        }
      } finally {
        parser.delete();
      }
    }
  );
}
