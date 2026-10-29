import { Parser, type Tree } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

import { expectNodeRanges } from '../helpers/nodeRanges.js';
import { loadCurrentWasmBuild } from './wasmBuild';

const MalformedHeaders = [
  'class C implements readonly<<T>()=>T>;\ntype R = number<B>;\n',
  'class C implements infer<<T>()=>T>;\ntype R = number<B>;\n',
  'class C implements A, number<B;\n',
];
const RepairedHeader = 'class C implements Foo<(<T>() => T)> {}\ntype R = number;\n';
const FollowingFunction = 'export function following() { return 1; }';
const FollowingConstant = 'const sentinel = 1;';
const Following = `${FollowingFunction}\n${FollowingConstant}\n`;

for (const dialect of ['typescript', 'tsx']) {
  test(`reports malformed ${dialect} heritage and parses following declarations after a repaired header`, async () => {
    await Parser.init();
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const header of [...MalformedHeaders, RepairedHeader]) {
        const source = header + Following;
        const tree = parser.parse(source)!;
        try {
          checkFollowing(tree, source, header !== RepairedHeader);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });
}

function checkFollowing(tree: Tree, source: string, hasError: boolean): void {
  expect(tree.rootNode.hasError, source).toBe(hasError);
  expectNodeRanges(tree.rootNode, source);
  if (hasError) return;
  const declarations = tree.rootNode.namedChildren.filter((node) =>
    ['export_statement', 'lexical_declaration'].includes(node.type)
  );
  expect(
    declarations.map((node) => node.text),
    source
  ).toEqual([FollowingFunction, FollowingConstant]);
  for (const node of declarations) {
    expect(node.hasError, source).toBe(false);
  }
}
