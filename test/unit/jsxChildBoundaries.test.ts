import { Parser } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { loadCurrentWasmBuild } from './wasmBuild.js';

const Source = `const a = (
  <div>
    <span className="x">hi</span>
    <br />
    {value}
    <p></p>
    &amp;
    <i />
  </div>
);
`;

await Parser.init();

test('starts nested JSX elements at their opening angle', async () => {
  const parser = new Parser().setLanguage(await loadCurrentWasmBuild('tsx'));
  const tree = parser.parse(Source)!;
  try {
    expect(tree.rootNode.hasError, tree.rootNode.toString()).toBe(false);
    const reference = ts.createSourceFile('jsx.tsx', Source, ts.ScriptTarget.Latest, true);
    const expected: number[][] = [];
    function visit(node: ts.Node): void {
      if (ts.isJsxElement(node) || ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        expected.push([node.getStart(reference), node.end]);
      }
      ts.forEachChild(node, visit);
    }
    visit(reference);
    const elements = tree.rootNode.descendantsOfType([
      'jsx_element',
      'jsx_opening_element',
      'jsx_self_closing_element',
    ]);
    expect(elements.map((node) => [node.startIndex, node.endIndex])).toEqual(expected);
    for (const element of elements.filter((node) => node.type !== 'jsx_element')) {
      const angle = element.firstChild!;
      expect([angle.type, angle.startIndex, angle.endIndex]).toEqual(['<', element.startIndex, element.startIndex + 1]);
    }
  } finally {
    tree.delete();
    parser.delete();
  }
});
