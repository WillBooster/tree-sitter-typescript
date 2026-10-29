import { type Node, type Point } from '@willbooster/web-tree-sitter';
import { expect } from 'vitest';

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
