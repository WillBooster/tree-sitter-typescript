import fs from 'node:fs';

import { Edit, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import treeSitterJson from '../../tree-sitter.json';

import { compareEditedTree, position } from '../helpers/treeEdit.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

const Prefix = `declare function f<T>(value?: unknown): T;
declare class Box<T> {}
declare const holder: { f: typeof f };
const call = f<<T>() => T>();
const instance = f<<T>() => T>;
const optional = f?.<<T>() => T>();
const constructed = new Box<<T>() => T>();
const bare = new Box<<T>() => T>;
const tagged = f<<T>() => T>\`text\`;
const member = holder.f<<T>() => T>();
const arrow = () => f<<T>() => T>();
const asyncArrow = async () => f<<T>() => T>();
const bareArrow = () => f<<T>() => T>;
async function awaited() { return await f<<T>() => T>(); }
class Scope { field = f<<T>() => T>; after = 1; }
type GenericBox = Box<<T, U = Box<string>>(value: T) => U>;
const shifted = (1 << 2) >> 1;
let bits = 1;
bits <<= 2;
const compared = 1 < 2 && 3 > 2;
const editable = f<`;
const Suffix = `>();
const following = 1;
`;
const InitialArgument = '<T>() => T';

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves adjacent generic function arguments and shift operators through ${dialect} edits`, async () => {
    await Parser.init();
    const parser = new Parser();
    let query: Query | undefined;
    let highlights: Query | undefined;
    let tree: Tree | undefined;
    let source = Prefix + InitialArgument + Suffix;
    let argument = InitialArgument;
    try {
      const language = await loadCurrentWasmBuild(dialect);
      parser.setLanguage(language);
      query = new Query(language, '(type_arguments) @arguments (function_type) @function');
      const grammar = treeSitterJson.grammars.find((entry) => entry.name === dialect)!;
      highlights = new Query(language, grammar.highlights.map((file) => fs.readFileSync(file, 'utf8')).join('\n'));
      tree = parser.parse(source)!;
      checkArguments(tree, source, dialect, query, highlights);
      for (const nextArgument of [
        ' <T>() => T',
        '/* gap */<T>() => T',
        '\n<T>() => T',
        '<T extends { nested: Box<string> }>(value: T) => T',
        '<T = string>(value?: T) => T',
        '<const T>() => T',
        '<T, U = Box<string>>(value: T) => U',
        String.raw`<\u0054>() => T`,
        '<Ｔ>() => Ｔ',
        '<LongTypeParameterName>() => LongTypeParameterName',
        InitialArgument,
      ]) {
        const next = Prefix + nextArgument + Suffix;
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex: Prefix.length,
            oldEndIndex: Prefix.length + argument.length,
            newEndIndex: Prefix.length + nextArgument.length,
            startPosition: position(source, Prefix.length),
            oldEndPosition: position(source, Prefix.length + argument.length),
            newEndPosition: position(next, Prefix.length + nextArgument.length),
          }),
          (incremental, fresh) => {
            checkArguments(incremental, next, dialect, query!, highlights!);
            checkArguments(fresh, next, dialect, query!, highlights!);
          }
        );
        previous.delete();
        source = next;
        argument = nextArgument;
      }
    } finally {
      tree?.delete();
      query?.delete();
      highlights?.delete();
      parser.delete();
    }
  });

  test(`keeps complete and incomplete shift chains linear in ${dialect}`, { timeout: 60_000 }, async () => {
    await Parser.init();
    const parser = new Parser();
    try {
      parser.setLanguage(await loadCurrentWasmBuild(dialect));
      for (const operator of ['<<', '<<=']) {
        for (const suffix of ['', '1;']) {
          const small = `value ${operator}\n`.repeat(1000) + suffix;
          const large = `value ${operator}\n`.repeat(10_000) + suffix;
          const hasError = suffix === '';
          checkShiftGrowth(parser, small, large, hasError, `${operator} ${suffix}`);
        }
      }
      for (const [name, source] of Object.entries({
        sequence: (count: number) => 'value << other,\n'.repeat(count) + '1;',
        array: (count: number) => 'const values = [' + 'value << other,'.repeat(count) + '1];',
        call: (count: number) => 'f(' + 'value << other,'.repeat(count) + '1);',
        object: (count: number) =>
          'const object = {' +
          Array.from({ length: count }, (_, index) => `p${index}: value << other,`).join('') +
          '};',
      })) {
        checkShiftGrowth(parser, source(1000), source(10_000), false, name);
      }
    } finally {
      parser.delete();
    }
  });
}

function checkShiftGrowth(parser: Parser, small: string, large: string, hasError: boolean, name: string): void {
  parseShiftCpu(parser, large, hasError);
  parseShiftCpu(parser, large, hasError);
  let smallFastest = Infinity;
  let largeFastest = Infinity;
  for (let run = 0; run < 5; run++) {
    smallFastest = Math.min(smallFastest, parseShiftCpu(parser, small, hasError));
    largeFastest = Math.min(largeFastest, parseShiftCpu(parser, large, hasError));
  }
  expect(largeFastest / smallFastest, name).toBeLessThan(18);
}

function parseShiftCpu(parser: Parser, source: string, hasError: boolean): number {
  const start = process.threadCpuUsage();
  const tree = parser.parse(source)!;
  const elapsed = process.threadCpuUsage(start);
  try {
    expect(tree.rootNode.hasError).toBe(hasError);
    return elapsed.user + elapsed.system;
  } finally {
    tree.delete();
  }
}

function checkArguments(tree: Tree, source: string, dialect: string, query: Query, highlights: Query): void {
  expect(tree.rootNode.hasError, source).toBe(false);
  const reference = ts.createSourceFile(
    `arguments.${dialect === 'tsx' ? 'tsx' : 'ts'}`,
    source,
    ts.ScriptTarget.Latest,
    true,
    dialect === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const argumentsRanges: [string, number, number][] = [];
  const functionRanges: [string, number, number][] = [];
  const operators: [string, number, number][] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isCallExpression(node) ||
        ts.isNewExpression(node) ||
        ts.isTaggedTemplateExpression(node) ||
        ts.isExpressionWithTypeArguments(node) ||
        ts.isTypeReferenceNode(node)) &&
      node.typeArguments?.length
    ) {
      const start = node.typeArguments.pos - 1;
      const close = node.getChildren(reference).find((child) => child.kind === ts.SyntaxKind.GreaterThanToken)!;
      argumentsRanges.push([source.slice(start, close.end), start, close.end]);
    }
    if (ts.isFunctionTypeNode(node)) functionRanges.push([node.getText(reference), node.getStart(reference), node.end]);
    if (ts.isBinaryExpression(node)) {
      operators.push([
        node.operatorToken.getText(reference),
        node.operatorToken.getStart(reference),
        node.operatorToken.end,
      ]);
    }
    ts.forEachChild(node, visit);
  };
  visit(reference);
  const captures = query.captures(tree.rootNode);
  for (const [name, expected] of [
    ['arguments', argumentsRanges],
    ['function', functionRanges],
  ] as const) {
    expect(
      captures.filter((capture) => capture.name === name).map(({ node }) => [node.text, node.startIndex, node.endIndex])
    ).toEqual(expected);
  }
  const parsedOperators = tree.rootNode
    .descendantsOfType(['binary_expression', 'augmented_assignment_expression'])
    .map((node) => node.childForFieldName('operator')!);
  expect(parsedOperators.map((node) => [node.text, node.startIndex, node.endIndex])).toEqual(operators);
  const operatorHighlights = highlights.captures(tree.rootNode).filter((capture) => capture.name === 'operator');
  for (const node of parsedOperators) {
    expect(node.isNamed).toBe(false);
    expect(node.children).toHaveLength(0);
    expect(
      operatorHighlights
        .filter((capture) => capture.node.startIndex >= node.startIndex && capture.node.endIndex <= node.endIndex)
        .map((capture) => [capture.node.text, capture.node.startIndex, capture.node.endIndex])
    ).toEqual([[node.text, node.startIndex, node.endIndex]]);
  }
  for (const { node } of captures.filter((capture) => capture.name === 'arguments')) {
    expect(node.parent!.childForFieldName('type_arguments')?.id).toBe(node.id);
  }
  expect(tree.rootNode.lastNamedChild!.text).toBe('const following = 1;');
}
