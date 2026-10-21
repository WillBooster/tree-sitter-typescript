import { Edit, Parser, type Tree } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

import { compareEditedTree, expectNodeRanges, position } from '../helpers/treeEdit';
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
  test(`reports malformed ${dialect} heritage and restores following declarations after repair`, async () => {
    await Parser.init();
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const malformed of MalformedHeaders) {
        let prefix = malformed;
        const source = prefix + Following;
        let tree = parser.parse(source)!;
        try {
          checkFollowing(tree, source, true);
          for (const replacement of [RepairedHeader, malformed]) {
            const nextSource = replacement + Following;
            const next = compareEditedTree(
              parser,
              tree,
              nextSource,
              new Edit({
                startIndex: 0,
                oldEndIndex: prefix.length,
                newEndIndex: replacement.length,
                startPosition: { row: 0, column: 0 },
                oldEndPosition: position(prefix, prefix.length),
                newEndPosition: position(replacement, replacement.length),
              }),
              (incremental, fresh) => {
                checkFollowing(incremental, nextSource, replacement === malformed);
                checkFollowing(fresh, nextSource, replacement === malformed);
              },
              true
            );
            tree.delete();
            tree = next;
            prefix = replacement;
          }
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
