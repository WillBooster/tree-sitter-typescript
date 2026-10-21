import fs from 'node:fs';

import { Edit, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import treeSitterJson from '../../tree-sitter.json';

import { compareEditedTree, position } from '../helpers/treeEdit.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

const Prefix = `declare function f<T>(value?: unknown): T;
declare class Box<T> {}
declare class Ｂｏｘ<T> {}
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
type ConstrainedBox = Box<<T, U extends <V>() => V>() => U>;
type UnicodeBox = Ｂｏｘ/* gap */<<T>() => T>;
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
  test(`validates escaped generic type names through ${dialect} edits`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser().setLanguage(language);
    const grammar = treeSitterJson.grammars.find((entry) => entry.name === dialect)!;
    const queries = (['highlights', 'tags', 'locals', 'injections'] as const).map(
      (kind) =>
        new Query(
          language,
          [grammar[kind]]
            .flat()
            .map((file) => fs.readFileSync(file, 'utf8'))
            .join('\n')
        )
    );
    const prefix = 'type Result = ';
    const suffix = '<number>;\nconst following = 1;';
    let name = 'Foo';
    let source = prefix + name + suffix;
    let tree = parser.parse(source)!;
    const check = (parsed: Tree, text: string, identifier: string, hasError: boolean): void => {
      expect(parsed.rootNode.hasError, text).toBe(hasError);
      if (!hasError) {
        const generic = parsed.rootNode.descendantsOfType('generic_type')[0]!;
        const typeName = generic.childForFieldName('name')!;
        expect([typeName.text, typeName.startIndex, typeName.endIndex]).toEqual([
          identifier,
          prefix.length,
          prefix.length + identifier.length,
        ]);
        expect(generic.childForFieldName('type_arguments')!.text).toBe('<number>');
        expect(parsed.rootNode.lastNamedChild!.text).toBe('const following = 1;');
      }
    };
    const captures = (parsed: Tree): unknown =>
      queries.map((query) =>
        query
          .captures(parsed.rootNode)
          .map(({ name: capture, node }) => [capture, node.type, node.text, node.startIndex, node.endIndex])
      );
    try {
      check(tree, source, name, false);
      const validNames = [String.raw`\u0046oo`, String.raw`\u{46}oo`, 'Ｆｏｏ', '𐐀'];
      const invalidNames = [
        String.raw`\u`,
        '\\',
        String.raw`\u{}`,
        String.raw`\u123`,
        String.raw`\u{41`,
        String.raw`\u00zz`,
        String.raw`A\u`,
        '#Foo',
      ];
      const edits = [
        ...validNames.map((name) => ({ name, hasError: false })),
        ...invalidNames.map((name) => ({ name, hasError: true })),
        { name: 'Foo', hasError: false },
      ];
      for (const { name: nextName, hasError } of edits) {
        const next = prefix + nextName + suffix;
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex: prefix.length,
            oldEndIndex: prefix.length + name.length,
            newEndIndex: prefix.length + nextName.length,
            startPosition: position(source, prefix.length),
            oldEndPosition: position(source, prefix.length + name.length),
            newEndPosition: position(next, prefix.length + nextName.length),
          }),
          (incremental, fresh) => {
            check(incremental, next, nextName, hasError);
            check(fresh, next, nextName, hasError);
            expect(captures(incremental)).toEqual(captures(fresh));
          },
          true
        );
        previous.delete();
        source = next;
        name = nextName;
      }
    } finally {
      tree.delete();
      for (const query of queries) query.delete();
      parser.delete();
    }
  });

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

  test(`preserves Flow generic constraints through ${dialect} edits`, async () => {
    await Parser.init();
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    const prefix = 'type U = string; type Box<T> = T;\ntype Result = Box<<T';
    const suffix = '>(value: T) => T>;\nconst following = 1;';
    let clause = ': U';
    let source = prefix + clause + suffix;
    let tree = parser.parse(source)!;
    try {
      checkFlowConstraint(tree, source, clause);
      for (const nextClause of [
        ' extends U',
        ': <V>() => V',
        ' extends <V>() => V',
        ': { item: U }',
        ' extends { item: U }',
        ': U',
      ]) {
        const next = prefix + nextClause + suffix;
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex: prefix.length,
            oldEndIndex: prefix.length + clause.length,
            newEndIndex: prefix.length + nextClause.length,
            startPosition: position(source, prefix.length),
            oldEndPosition: position(source, prefix.length + clause.length),
            newEndPosition: position(next, prefix.length + nextClause.length),
          }),
          (incremental, fresh) => {
            checkFlowConstraint(incremental, next, nextClause);
            checkFlowConstraint(fresh, next, nextClause);
          }
        );
        previous.delete();
        source = next;
        clause = nextClause;
      }
    } finally {
      tree.delete();
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

function checkFlowConstraint(tree: Tree, source: string, clause: string): void {
  expect(tree.rootNode.hasError, source).toBe(false);
  const argument = `<T${clause}>(value: T) => T`;
  const generic = tree.rootNode.descendantsOfType('generic_type').find((node) => node.text.startsWith('Box<'))!;
  const args = generic.childForFieldName('type_arguments')!;
  expect(args.text).toBe(`<${argument}>`);
  const functionType = args.namedChildren[0]!;
  expect([functionType.type, functionType.text, functionType.startIndex, functionType.endIndex]).toEqual([
    'function_type',
    argument,
    source.indexOf(argument),
    source.indexOf(argument) + argument.length,
  ]);
  const parameter = functionType.childForFieldName('type_parameters')!.namedChildren[0]!;
  expect(parameter.childForFieldName('name')!.text).toBe('T');
  const constraint = parameter.childForFieldName('constraint')!;
  expect([constraint.text, constraint.startIndex, constraint.endIndex]).toEqual([
    clause.trimStart(),
    source.indexOf(clause) + clause.length - clause.trimStart().length,
    source.indexOf(clause) + clause.length,
  ]);
  expect(tree.rootNode.lastNamedChild!.text).toBe('const following = 1;');
}
