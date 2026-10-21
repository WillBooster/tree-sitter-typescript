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

export function expectNodeRanges(node: Node, source: string): void {
  expect(node.startIndex).toBeGreaterThanOrEqual(0);
  expect(node.endIndex).toBeGreaterThanOrEqual(node.startIndex);
  expect(node.endIndex).toBeLessThanOrEqual(source.length);
  expect(node.startPosition).toEqual(position(source, node.startIndex));
  expect(node.endPosition).toEqual(position(source, node.endIndex));
  expect(node.text).toBe(source.slice(node.startIndex, node.endIndex));
  for (const child of node.children) expectNodeRanges(child, source);
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
