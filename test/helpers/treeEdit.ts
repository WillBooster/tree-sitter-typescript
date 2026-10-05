import { type Edit, type Node, type Parser, type Point, type Tree } from '@willbooster/web-tree-sitter';
import { expect } from 'vitest';

export function compareEditedTree(
  parser: Parser,
  previous: Tree,
  source: string,
  edit: Edit,
  check: (incremental: Tree, fresh: Tree) => void,
  allowErrors = false
): Tree {
  previous.edit(edit);
  const incremental = parser.parse(source, previous)!;
  let fresh: Tree | undefined;
  try {
    fresh = parser.parse(source)!;
    if (!allowErrors) expect(incremental.rootNode.hasError).toBe(false);
    expect(snapshot(incremental.rootNode)).toEqual(snapshot(fresh.rootNode));
    check(incremental, fresh);
    return incremental;
  } catch (error) {
    incremental.delete();
    throw error;
  } finally {
    fresh?.delete();
  }
}

export function position(source: string, index: number): Point {
  const lines = source.slice(0, index).split('\n');
  return { row: lines.length - 1, column: lines.at(-1)!.length };
}

function snapshot(node: Node): unknown {
  return [
    node.type,
    node.isNamed,
    node.isMissing,
    node.isExtra,
    node.hasError,
    node.startIndex,
    node.endIndex,
    node.startPosition,
    node.endPosition,
    node.children.map((_, i) => node.fieldNameForChild(i)),
    node.children.map(snapshot),
  ];
}
