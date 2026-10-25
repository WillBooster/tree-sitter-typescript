import fs from 'node:fs';

import { Edit, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import treeSitterJson from '../../tree-sitter.json';
import { finishCpuMeasurement, type ParseCpuMeasurement, startCpuMeasurement } from '../helpers/parseCpuMeasurement.js';
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

interface ShiftCase {
  name: string;
  source: (count: number) => string;
  hasError: boolean;
}
const ShiftCases: ShiftCase[] = [
  ...['<<', '<<='].flatMap((operator) =>
    ['', '1;'].map((suffix) => ({
      name: `${operator} ${suffix}`,
      source: (count: number) => `value ${operator}\n`.repeat(count) + suffix,
      hasError: suffix === '',
    }))
  ),
  ...Object.entries({
    genericCallChain: (count: number) => 'x = ' + 'f<T>(x) <<\n'.repeat(count) + '1;',
    genericCallArray: (count: number) => 'const values = [' + 'f<T>(x) << g<U>(y),'.repeat(count) + '1];',
    newOperandChain: (count: number) => 'x = ' + 'f<T>(x) << new A <<\n'.repeat(count) + '1;',
    typeofOperandChain: (count: number) => 'x = ' + 'f<T>(x) << typeof a <<\n'.repeat(count) + '1;',
    awaitOperandChain: (count: number) => 'x = ' + 'f<T>(x) << await a <<\n'.repeat(count) + '1;',
    voidOperandChain: (count: number) => 'x = ' + 'f<T>(x) << void 0 <<\n'.repeat(count) + '1;',
    deleteOperandChain: (count: number) => 'x = ' + 'f<T>(x) << delete a <<\n'.repeat(count) + '1;',
    callOperandChain: (count: number) => 'x = ' + 'f<T>(x) << g(x) <<\n'.repeat(count) + '1;',
    subtractionOperandChain: (count: number) => 'x = ' + 'f<T>(x) << a - 1 <<\n'.repeat(count) + '1;',
    additionOperandChain: (count: number) => 'x = ' + 'f<T>(x) << a + 1 <<\n'.repeat(count) + '1;',
    productOperandChain: (count: number) => 'x = ' + 'f<T>(x) << a * 1 <<\n'.repeat(count) + '1;',
    divisionOperandChain: (count: number) => 'x = ' + 'f<T>(x) << a / 1 <<\n'.repeat(count) + '1;',
    memberOperandChain: (count: number) => 'x = ' + 'f<T>(x) << ns.g(x) <<\n'.repeat(count) + '1;',
    indexedOperandChain: (count: number) => 'x = ' + 'f<T>(x) << a[0] <<\n'.repeat(count) + '1;',
    optionalOperandChain: (count: number) => 'x = ' + 'f<T>(x) << a?.b <<\n'.repeat(count) + '1;',
    optionalCallOperandChain: (count: number) => 'x = ' + 'f<T>(x) << g?.(x) <<\n'.repeat(count) + '1;',
    sequence: (count: number) => 'value << other,\n'.repeat(count) + '1;',
    array: (count: number) => 'const values = [' + 'value << other,'.repeat(count) + '1];',
    relational: (count: number) => 'value > other << third,\n'.repeat(count) + '1;',
    queryArray: (count: number) => 'const values = [' + 'foo as typeof ns.Foo << 1,'.repeat(count) + '1];',
    call: (count: number) => 'f(' + 'value << other,'.repeat(count) + '1);',
    object: (count: number) =>
      'const object = {' + Array.from({ length: count }, (_, index) => `p${index}: value << other,`).join('') + '};',
  }).map(([name, source]) => ({ name, source, hasError: false })),
];

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves relational grouping through ${dialect} edits`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser().setLanguage(language);
    const query = new Query(language, '(type_arguments) @arguments (function_type) @function');
    const grammar = treeSitterJson.grammars.find((entry) => entry.name === dialect)!;
    const highlights = new Query(language, grammar.highlights.map((file) => fs.readFileSync(file, 'utf8')).join('\n'));
    const prefix = 'const result = ';
    const suffix = ';\nconst following = 1;';
    let expression = 'a > b < c';
    let source = prefix + expression + suffix;
    let tree = parser.parse(source)!;
    const check = (parsed: Tree, text: string): void => {
      const diagnostics =
        ts.transpileModule(text, {
          reportDiagnostics: true,
          fileName: dialect === 'tsx' ? 'fixture.tsx' : 'fixture.ts',
          compilerOptions: { target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.Preserve },
        }).diagnostics ?? [];
      if (diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
        expect(parsed.rootNode.hasError, text).toBe(true);
      } else {
        checkArguments(parsed, text, dialect, query, highlights);
      }
    };
    try {
      checkArguments(tree, source, dialect, query, highlights);
      const controls = dialect === 'typescript' ? ['< <T>() => T>x', '<Box<<T>() => T>>x'] : ['<div>{a <!-- b}</div>'];
      for (const expression of controls) {
        const text = prefix + expression + suffix;
        const control = parser.parse(text)!;
        try {
          checkArguments(control, text, dialect, query, highlights);
        } finally {
          control.delete();
        }
      }
      for (const nextExpression of [
        'a < b < c',
        'a >= b < c',
        'a <= b < c',
        'a < b > c',
        'a > b << c',
        'a << b < c',
        'a > b < c > d',
        'a < B<C>> d',
        'a < B<C>> [0]',
        'a < B<C>> `t`',
        'a < B<C>> !d',
        'a >= b < c instanceof d',
        'a < b ** c',
        'a * b < c << d',
        'f<T>(x) << new A << 1',
        'f<T>(x) << typeof a << 1',
        'f<T>(x) << await a << 1',
        'f<T>(x) << void 0 << 1',
        'f<T>(x) << delete a << 1',
        'foo as typeof ns.Foo << 1',
        'foo as typeof ns.Foo.Bar << 1',
        'foo satisfies typeof ns.Foo << 1',
        'foo as typeof Foo << 1',
        'foo as typeof ns.Foo<T> << 1',
        'foo as typeof ns.Foo<<T>() => T> << 1',
        'foo as typeof ns.Foo< <T>() => T> << 1',
        'x => x\n<< import(1)',
        'async () => await 1 << 2',
        'async () => ({a: assert}) << -0x1',
        'async ({a, b: c}: <T>() => null, z) => 1_0 << 0',
        '({a = 1}, x: symbol) => constructor << c?.(y)',
        'b => c <</*\n*/`t`',
        'x => x /* before */ << 1',
        'async () => await f! << 1',
        'async () => await f! /*\n*/ << 1',
        'async () => await instanceOfFoo << 1',
        'a as B < c',
        'a satisfies B < c > d',
        'a as ns.B < c',
        'a satisfies ns.B < c > d',
        'a as B\n< c',
        'a as ns.B\n< c',
        '(a <!-- b)',
        'yield << 1',
        'yield /* gap */ << 1',
        'a > b < c',
      ]) {
        const next = prefix + nextExpression + suffix;
        const previous = tree;
        tree = compareEditedTree(
          parser,
          previous,
          next,
          new Edit({
            startIndex: prefix.length,
            oldEndIndex: prefix.length + expression.length,
            newEndIndex: prefix.length + nextExpression.length,
            startPosition: position(source, prefix.length),
            oldEndPosition: position(source, prefix.length + expression.length),
            newEndPosition: position(next, prefix.length + nextExpression.length),
          }),
          (incremental, fresh) => {
            check(incremental, next);
            check(fresh, next);
          },
          true
        );
        previous.delete();
        expression = nextExpression;
        source = next;
      }
    } finally {
      tree.delete();
      query.delete();
      highlights.delete();
      parser.delete();
    }
  });

  test(`preserves HTML comments after assertion type names through ${dialect} edits`, async () => {
    await Parser.init();
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    const prefix = 'const result = x as ';
    const suffix = ' <!-- c\n<1>;\nconst following = 1;';
    let name = 'A';
    let source = prefix + name + suffix;
    let tree = parser.parse(source)!;
    try {
      checkHtmlComments(tree, source);
      for (const nextName of ['ns.A', 'ns.deep.A', 'A']) {
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
            checkHtmlComments(incremental, next);
            checkHtmlComments(fresh, next);
          },
          true
        );
        previous.delete();
        source = next;
        name = nextName;
      }
    } finally {
      tree.delete();
      parser.delete();
    }
  });

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
        '< /* header */ T>() => T',
        '<T /* header */>() => T',
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

  test.each(ShiftCases)(
    `keeps $name growth linear in ${dialect}`,
    { timeout: 60_000 },
    async ({ name, source, hasError }) => {
      await Parser.init();
      const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
      try {
        checkShiftGrowth(parser, source(1000), source(10_000), hasError, name, dialect);
      } finally {
        parser.delete();
      }
    }
  );
}

interface ShiftCpuMeasurement extends ParseCpuMeasurement {
  sourceLength: number;
  repetitions: number;
}

function checkShiftGrowth(
  parser: Parser,
  small: string,
  large: string,
  hasError: boolean,
  name: string,
  dialect: string
): void {
  const measurements: ShiftCpuMeasurement[] = [];
  parseShiftCpu(parser, large, hasError, 1, measurements);
  parseShiftCpu(parser, large, hasError, 1, measurements);
  // Linux thread CPU accounting can quantize a short parse; equal parse/dispose batches keep that error small.
  let repetitions = 1;
  while (repetitions < 32 && parseShiftCpu(parser, small, hasError, repetitions, measurements) < 16_000)
    repetitions *= 2;
  const samples = Array.from({ length: 5 }, () => [
    parseShiftCpu(parser, small, hasError, repetitions, measurements),
    parseShiftCpu(parser, large, hasError, repetitions, measurements),
  ]);
  if (name === 'genericCallArray')
    process.stdout.write(`Generic-call array CPU measurements: ${JSON.stringify({ dialect, measurements })}\n`);
  const growthRatios = samples.map(([smallCpu, largeCpu]) => largeCpu! / smallCpu!).toSorted((a, b) => a - b);
  const medianGrowth = growthRatios[Math.floor(growthRatios.length / 2)]!;
  expect(
    medianGrowth,
    `${name}: ${repetitions} parses per small/large thread CPU sample ${JSON.stringify(samples)}`
  ).toBeLessThan(18);
}

function parseShiftCpu(
  parser: Parser,
  source: string,
  hasError: boolean,
  repetitions: number,
  measurements: ShiftCpuMeasurement[]
): number {
  const start = startCpuMeasurement();
  let errorCount = 0;
  for (let run = 0; run < repetitions; run++) {
    const tree = parser.parse(source)!;
    try {
      errorCount += Number(tree.rootNode.hasError);
    } finally {
      tree.delete();
    }
  }
  const measurement = finishCpuMeasurement(start);
  measurements.push({ sourceLength: source.length, repetitions, ...measurement });
  expect(errorCount).toBe(Number(hasError) * repetitions);
  return measurement.threadCpuMicroseconds;
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
  const binaryRanges: (string | number)[][] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isCallExpression(node) ||
        ts.isNewExpression(node) ||
        ts.isTaggedTemplateExpression(node) ||
        ts.isExpressionWithTypeArguments(node) ||
        ts.isTypeReferenceNode(node) ||
        ts.isTypeQueryNode(node)) &&
      node.typeArguments?.length
    ) {
      const start = node.typeArguments.pos - 1;
      const close = node.getChildren(reference).find((child) => child.kind === ts.SyntaxKind.GreaterThanToken)!;
      argumentsRanges.push([source.slice(start, close.end), start, close.end]);
    }
    if (ts.isTypeAssertionExpression(node)) {
      const close = node.getChildren(reference).find((child) => child.kind === ts.SyntaxKind.GreaterThanToken)!;
      const start = node.getStart(reference);
      argumentsRanges.push([source.slice(start, close.end), start, close.end]);
    }
    if (ts.isFunctionTypeNode(node)) functionRanges.push([node.getText(reference), node.getStart(reference), node.end]);
    if (ts.isBinaryExpression(node)) {
      binaryRanges.push([
        node.getStart(reference),
        node.end,
        node.left.getStart(reference),
        node.left.end,
        node.operatorToken.getText(reference),
        node.right.getStart(reference),
        node.right.end,
      ]);
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
  const binaries = tree.rootNode.descendantsOfType(['binary_expression', 'augmented_assignment_expression']);
  expect(
    binaries.map((node) => {
      const left = node.childForFieldName('left')!;
      const right = node.childForFieldName('right')!;
      return [
        node.startIndex,
        node.endIndex,
        left.startIndex,
        left.endIndex,
        node.childForFieldName('operator')!.text,
        right.startIndex,
        right.endIndex,
      ];
    })
  ).toEqual(binaryRanges);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  const comments: [string, number, number][] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      comments.push([
        source.slice(scanner.getTokenPos(), scanner.getTextPos()),
        scanner.getTokenPos(),
        scanner.getTextPos(),
      ]);
    }
  }
  expect(tree.rootNode.descendantsOfType('comment').map((node) => [node.text, node.startIndex, node.endIndex])).toEqual(
    comments
  );
  const parsedOperators = binaries.map((node) => node.childForFieldName('operator')!);
  expect(parsedOperators.map((node) => [node.text, node.startIndex, node.endIndex])).toEqual(operators);
  const operatorHighlights = highlights.captures(tree.rootNode);
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
    const parent = node.parent!;
    expect(
      parent.type === 'type_assertion' ? parent.firstNamedChild!.id : parent.childForFieldName('type_arguments')?.id
    ).toBe(node.id);
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

function checkHtmlComments(parsed: Tree, text: string): void {
  expect(parsed.rootNode.hasError, text).toBe(false);
  const start = text.indexOf('<!--');
  expect(
    parsed.rootNode.descendantsOfType('html_comment').map((node) => [node.text, node.startIndex, node.endIndex])
  ).toEqual([['<!-- c', start, start + 6]]);
  expect(parsed.rootNode.descendantsOfType('binary_expression')).toHaveLength(0);
  expect(parsed.rootNode.lastNamedChild!.text).toBe('const following = 1;');
}
