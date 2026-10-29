import fs from 'node:fs';
import path from 'node:path';

import { Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { loadCurrentWasmBuild } from './wasmBuild.js';

const RecoveryCases: [string, boolean, string, string, string?, string?, string?, string?][] = [];
const CommonRecoveryTails = [
  ' : string',
  ': string',
  ' as string',
  ': string = 1',
  ' symbol',
  ' unique',
  ' unique symbol',
  ' => number',
  ' number',
  ' boolean',
  ' unknown',
  ' object',
  ' string',
  ' ? string : number',
  ' satisfies string',
  ' as unknown',
];
for (const word of ['value', 'foo', 'f']) {
  const tails = [...CommonRecoveryTails];
  if (word !== 'value') tails.push(' never');
  if (word === 'f') tails.push(' any');
  for (const declaration of [true, false])
    for (const tail of tails) RecoveryCases.push([word, declaration, tail, ' { }']);
}
for (const declaration of [true, false]) {
  const tails = [': string', ': string = 1', ' unique symbol', ' as unknown'];
  if (!declaration) tails.push(' boolean', ' unknown');
  for (const tail of tails) RecoveryCases.push(['foobar', declaration, tail, ' { }']);
}
RecoveryCases.push(['out', true, ' symbol', ' { }']);
for (const tail of [' : string', ': string', ' as string', ': string = 1'])
  RecoveryCases.push(['value', false, tail, ' { if (!value) throw Error(); }']);

const KeywordRecoveryTails = [' symbol', ' number', ' string', ' object', ' unique symbol', ' boolean', ' unknown'];
for (const word of ['value', 'x', 'f', 'foo', 'data', 'input', 'arg']) {
  const tails = [...KeywordRecoveryTails];
  if (!['value', 'input'].includes(word)) tails.push(' never');
  if (['x', 'f'].includes(word)) tails.push(' any');
  for (const tail of tails)
    RecoveryCases.push([word, true, tail, '', word, '\nconst sentinel = 1;\nconst after = 2;\n']);
}

const AdditionalRecoveryTails = [' out symbol', ' as symbol', ' this symbol', ' keyof symbol', ' infer symbol'];
for (const word of ['value', 'foo', 'f']) {
  for (const declaration of [true, false]) {
    const tails = [...AdditionalRecoveryTails];
    if (!declaration) tails.push(' void symbol');
    for (const tail of tails) RecoveryCases.push([word, declaration, tail, ' { }']);
  }
}
RecoveryCases.push(['foobar', false, ' void symbol', ' { }']);
for (const container of ['interface', 'class', 'typeLiteral', 'functionType']) {
  for (const word of ['value', 'foo', 'foobar', 'f']) {
    const tails =
      word === 'foobar'
        ? container === 'functionType'
          ? [': string', ' unique symbol', ' as unknown']
          : [': string', ': string = 1', ' unique symbol', ' boolean', ' unknown', ' as unknown']
        : [...CommonRecoveryTails, ...AdditionalRecoveryTails];
    if (word !== 'foobar') {
      if (container === 'functionType') {
        tails.splice(tails.indexOf(': string = 1'), 1);
        tails.splice(tails.indexOf(' ? string : number'), 1);
      } else tails.push(' void symbol');
      if (word !== 'value') tails.push(' never');
      if (word === 'f') tails.push(' any');
    } else if (container === 'interface') tails.push(' void symbol');
    const [prefix, suffix] = {
      interface: ['interface I { m(value: unknown): asserts ', '; }'],
      class: ['class C { m(value: unknown): asserts ', ' { } }'],
      typeLiteral: ['type T = { m(value: unknown): asserts ', '; };'],
      functionType: ['type T = (value: unknown) => asserts ', ';'],
    }[container]!;
    for (const tail of tails) RecoveryCases.push([word, false, tail, '', undefined, undefined, prefix + word, suffix]);
  }
}

const FurtherKeywordPrefixes = [
  'readonly',
  'abstract',
  'declare',
  'import',
  'function',
  'type',
  'interface',
  'global',
  'bigint',
  'asserts',
  'export',
  'in',
  'instanceof',
  'public',
  'private',
  'static',
  'override',
  'get',
  'set',
  'of',
  'async',
  'accessor',
  'intrinsic',
  'any',
  'number',
  'enum',
  'satisfies',
];
for (const word of ['value', 'foo', 'foobar', 'f']) {
  for (const declaration of [true, false]) {
    const keywords =
      word === 'foobar' ? ['import', 'function', 'type', 'interface', 'async', 'enum'] : FurtherKeywordPrefixes;
    for (const keyword of keywords) {
      if (!declaration && ['interface', 'enum'].includes(keyword)) continue;
      RecoveryCases.push([word, declaration, ` ${keyword} symbol`, ' { }']);
    }
  }
  for (const [prefix, suffix] of [
    ['interface I { (value: unknown): asserts ', '; }'],
    ['type T = { (value: unknown): asserts ', '; };'],
    ['declare abstract class C { abstract m(value: unknown): asserts ', '; }'],
    ['interface I { m<T>(value: unknown): asserts ', '; }'],
  ]) {
    for (const tail of word === 'foobar'
      ? [' as unknown', ' unique symbol']
      : [' : string', ' as unknown', ' symbol', ' unique symbol']) {
      RecoveryCases.push([word, false, tail, '', undefined, undefined, prefix + word, suffix]);
    }
  }
}

for (const word of ['value', 'foo', 'foobar', 'f']) {
  const trailing =
    word === 'foobar'
      ? ['boolean', 'unknown']
      : ['symbol', 'string', 'unique', 'number', 'object', 'boolean', 'unknown'];
  if (['foo', 'f'].includes(word)) trailing.push('never');
  if (word === 'f') trailing.push('any');
  const tails = ['zzz', '123'].flatMap((prefix) => trailing.map((last) => ` ${prefix} ${last}`));
  if (word !== 'foobar') tails.push(' qq symbol', ' foo symbol');
  for (const declaration of [true, false])
    for (const tail of tails) RecoveryCases.push([word, declaration, tail, ' { }']);
}

const RecoverySamples = RecoveryCases.map(([word, declaration, tail, body, parameter, following, prefix, suffix]) => ({
  word,
  tail,
  prefix:
    prefix ??
    `${declaration ? 'declare ' : ''}function f(${parameter ?? (word === 'out' ? 'out' : 'value')}: unknown): asserts ${word}`,
  suffix: suffix ?? (declaration ? ';' : body),
  following: following ?? '\nconst sentinel = 1;\n',
}));

const Source = fs.readFileSync(path.join(import.meta.dirname, '../fixtures/predefinedAssertionNames.ts'), 'utf8');

describe.each(['typescript', 'tsx'])('%s assertion names', (dialect) => {
  let language: Awaited<ReturnType<typeof loadCurrentWasmBuild>>;
  let query: Query;
  let predicates: Query;
  const queries: Query[] = [];
  beforeAll(async () => {
    await Parser.init();
    language = await loadCurrentWasmBuild(dialect);
    query = new Query(language, '(asserts . (identifier) @name)');
    queries.push(query);
    predicates = new Query(language, '(type_predicate name: (identifier) @name type: (_) @type)');
    queries.push(predicates);
  }, 30_000);
  afterAll(() => {
    for (const resource of queries) resource.delete();
  });
  test.each(['any', 'number', 'boolean', 'string', 'symbol', 'unknown', 'never', 'object', 'unique'])(
    'recognizes %s and a renamed parameter as assertion names',
    (word) => {
      const parser = new Parser().setLanguage(language);
      try {
        const start = Source.indexOf(`asserts ${word}`) + 'asserts '.length;
        for (const source of [Source, Source.slice(0, start) + 'parameter' + Source.slice(start + word.length)]) {
          const tree = parser.parse(source)!;
          try {
            check(tree, source);
          } finally {
            tree.delete();
          }
        }
        function check(current: Tree, text: string): void {
          const reference = ts.createSourceFile('assertions.ts', text, ts.ScriptTarget.Latest, true);
          const names: [string, number, number][] = [];
          const predicateRoles: [string, string, number, number][] = [];
          const visit = (node: ts.Node): void => {
            if (ts.isTypePredicateNode(node) && ts.isIdentifier(node.parameterName)) {
              const name = node.parameterName;
              if (node.type) {
                predicateRoles.push(['name', name.getText(reference), name.getStart(reference), name.getEnd()]);
                predicateRoles.push([
                  'type',
                  node.type.getText(reference),
                  node.type.getStart(reference),
                  node.type.getEnd(),
                ]);
              } else if (node.assertsModifier)
                names.push([name.getText(reference), name.getStart(reference), name.getEnd()]);
            }
            ts.forEachChild(node, visit);
          };
          visit(reference);
          expect(current.rootNode.hasError).toBe(false);
          expect(
            query.captures(current.rootNode).map(({ node }) => [node.text, node.startIndex, node.endIndex])
          ).toEqual(names);
          expect(
            predicates
              .captures(current.rootNode)
              .map(({ name, node }) => [name, node.text, node.startIndex, node.endIndex])
          ).toEqual(predicateRoles);
        }
      } finally {
        parser.delete();
      }
    }
  );
});

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves ${dialect} canonical assertion prefixes with and without malformed array tails`, async () => {
    await Parser.init();
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    try {
      for (const word of ['any', 'number', 'boolean', 'string', 'symbol', 'unknown', 'never', 'object', 'unique']) {
        for (const tail of ['', '[], number']) {
          const tree = parser.parse(
            `declare function f(value: unknown): asserts ${word}${tail};\nconst sentinel = 1;\n`
          )!;
          try {
            expect(tree.rootNode.hasError).toBe(tail !== '');
            const assertion = tree.rootNode.descendantsOfType('asserts').find((node) => node.isNamed)!;
            expect(assertion.namedChildren[0]!.type).toBe('identifier');
            expect(assertion.namedChildren[0]!.text).toBe(word);
            expect(tree.rootNode.descendantsOfType('expression_statement').map((node) => node.text)).toEqual(
              tail ? ['[], number;'] : []
            );
            expect(tree.rootNode.namedChildren.at(-1)!.text).toBe('const sentinel = 1;');
          } finally {
            tree.delete();
          }
        }
      }
    } finally {
      parser.delete();
    }
  });
}

describe.each(['typescript', 'tsx'])('%s ordinary-name assertion recovery', (dialect) => {
  let language: Awaited<ReturnType<typeof loadCurrentWasmBuild>>;
  let annotationQuery: Query | undefined;
  beforeAll(async () => {
    await Parser.init();
    language = await loadCurrentWasmBuild(dialect);
    annotationQuery = new Query(
      language,
      `
      (function_signature return_type: (_) @annotation)
      (function_declaration return_type: (_) @annotation)
      (method_signature return_type: (_) @annotation)
      (call_signature return_type: (_) @annotation)
      (abstract_method_signature return_type: (_) @annotation)
      (method_definition return_type: (_) @annotation)
      (function_type return_type: (_) @annotation)
    `
    );
  }, 30_000);
  afterAll(() => {
    annotationQuery?.delete();
  });
  test.each(RecoverySamples)('parses $prefix with and without $tail', ({ word, tail, prefix, suffix, following }) => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const inserted of [tail, '']) {
        const tree = parser.parse(`${prefix}${inserted}${suffix}${following}`)!;
        try {
          expect(tree.rootNode.hasError).toBe(inserted !== '');
          const sentinel = tree.rootNode.namedChildren.find((node) => node.text === 'const sentinel = 1;');
          expect(sentinel).toBeDefined();
          expect(sentinel!.hasError).toBe(false);
          expect(tree.rootNode.lastNamedChild?.text).toBe(following.trim().split('\n').at(-1));
          if (inserted !== '') continue;
          const annotations = annotationQuery!.captures(tree.rootNode);
          expect(annotations).toHaveLength(1);
          const annotation = annotations[0]!.node;
          const functionType = prefix.includes('=> asserts');
          expect(annotation.type).toBe(functionType ? 'asserts' : 'asserts_annotation');
          expect(annotation.startIndex).toBe(functionType ? prefix.indexOf('asserts') : prefix.indexOf(': asserts'));
          const assertion = functionType ? annotation : annotation.namedChildren[0]!;
          expect(assertion.type).toBe('asserts');
          const name = assertion.namedChildren.at(-1)!;
          expect(name.type).toBe('identifier');
          expect(name.text).toBe(word);
          expect(name.startIndex).toBe(prefix.lastIndexOf(word));
          expect(name.endIndex).toBe(prefix.lastIndexOf(word) + word.length);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });
});
