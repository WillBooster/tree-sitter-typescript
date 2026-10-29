import fs from 'node:fs';

import { type Node, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import configuration from '../../tree-sitter.json';
import { finishCpuMeasurement, type ParseCpuMeasurement, startCpuMeasurement } from '../helpers/parseCpuMeasurement.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

// Vitest cannot interrupt a synchronous parse. Share one cooperative emergency deadline across the
// sampled parses; the CPU ratio checks growth without using wall time as the performance target.
const parseHangCeilingMs = 60_000;

interface DeepReturnCpuMeasurement extends ParseCpuMeasurement {
  depth: number;
}

describe.each(['typescript', 'tsx'])('%s untyped function-type parameter names', (dialect) => {
  let language: Awaited<ReturnType<typeof loadCurrentWasmBuild>>;
  let queries: Query[] = [];

  beforeAll(async () => {
    await Parser.init();
    language = await loadCurrentWasmBuild(dialect);
    const grammar = configuration.grammars.find((entry) => entry.name === dialect)!;
    queries = (['highlights', 'tags', 'locals', 'injections'] as const).map(
      (kind) =>
        new Query(
          language,
          [grammar[kind]]
            .flat()
            .map((file: string) => fs.readFileSync(file, 'utf8'))
            .join('\n')
        )
    );
    queries.push(
      new Query(
        language,
        `(type/function_type) @function
      (required_parameter pattern: (pattern/identifier) @binding)
      (optional_parameter pattern: (pattern/identifier) @binding)`
      )
    );
  }, 30_000);
  afterAll(() => {
    for (const query of queries) query.delete();
  });

  test(
    'retains deeply parenthesized returns with bounded CPU growth',
    () => {
      const cpuMeasurements: DeepReturnCpuMeasurement[] = [];
      const deadline = performance.now() + parseHangCeilingMs;
      parseCpuTime(32_000, deadline, cpuMeasurements);
      parseCpuTime(32_000, deadline, cpuMeasurements);
      const smaller: number[] = [];
      const larger: number[] = [];
      for (let sample = 0; sample < 5; sample++) {
        smaller.push(parseCpuTime(16_000, deadline, cpuMeasurements));
        larger.push(parseCpuTime(32_000, deadline, cpuMeasurements));
      }
      // Thread CPU time includes foreground GC and allocation overhead. A median prevents a single
      // unusually fast or slow sample from deciding whether parser growth is superlinear.
      process.stdout.write(
        `Deep-return CPU measurements: ${JSON.stringify({ dialect, measurements: cpuMeasurements })}\n`
      );
      const smallerMedian = smaller.toSorted((a, b) => a - b)[2]!;
      const largerMedian = larger.toSorted((a, b) => a - b)[2]!;
      expect(largerMedian, `parse CPU samples (microseconds): ${JSON.stringify({ smaller, larger })}`).toBeLessThan(
        3 * smallerMedian
      );
    },
    2 * parseHangCeilingMs
  );

  function parseCpuTime(depth: number, deadline: number, cpuMeasurements: DeepReturnCpuMeasurement[]): number {
    const source = `type F=(unknown)=>${'('.repeat(depth)}T${')'.repeat(depth)};\nexport function f(){}\ntype B=2;`;
    const parser = new Parser().setLanguage(language);
    let tree: Tree | undefined;
    try {
      const start = startCpuMeasurement();
      tree = parser.parse(source, undefined, { progressCallback: () => performance.now() > deadline }) ?? undefined;
      const measurement = finishCpuMeasurement(start);
      cpuMeasurements.push({ depth, ...measurement });
      expect(tree, 'deep-return parse must complete before the emergency deadline').toBeDefined();
      expect(tree!.rootNode.hasError).toBe(false);
      expect(tree!.rootNode.namedChildren).toHaveLength(3);
      expect(
        queries
          .at(-1)!
          .captures(tree!.rootNode)
          .filter((capture) => capture.name === 'binding')
          .map((capture) => capture.node.text)
      ).toEqual(['unknown']);
      return measurement.threadCpuMicroseconds;
    } finally {
      tree?.delete();
      parser.delete();
    }
  }

  test.each(['unknown', 'never', 'unique'])('does not claim incomplete untyped headers for %s', (name) => {
    const parser = new Parser().setLanguage(language);
    const bindings = new Query(language, '(required_parameter pattern: (pattern/identifier) @name)');
    try {
      for (const continuation of ['=>', 'number', ')']) {
        const source = `type F=(${name})=>number;`;
        const start = source.indexOf(continuation);
        const incomplete =
          continuation === 'number'
            ? [
                '',
                '!',
                '~',
                '%',
                '^',
                '@',
                '#',
                '+',
                '-',
                '.',
                String.raw`\x`,
                '|',
                '&',
                'keyof',
                'typeof',
                'readonly',
                'infer',
                'unique',
                '()',
                'asserts import',
                'asserts new',
                'x is import',
                'infer import',
                '(x:T)=>new',
                '(x:T)=>import',
                'number import "x"',
                'number /* same line */ import "x"',
                'T |',
                'T &',
                'x is',
                'asserts',
                'T extends U ?',
                'T extends U ? T :',
                'T extends U ? T',
                'a?.1:b',
                'a?.0:b',
                '(x=T extends U)=>U',
                '(x=T extends U ? V)=>U',
                '(x=T extends U ? V:W)=>U',
                '{m(x=T extends U):void}',
                '(x=a ? b)=>U',
                '(x=a ? b :)=>U',
                '(x=a ? :c)=>U',
                '[T |]',
                '{p:T |}',
                '{p:T &}',
                '[T &]',
                '[T.]',
                'Array<T |>',
                'Array<T &>',
                '(T |)',
                '(T &)',
                '[T |, U]',
                '[T %]',
                '{p:T %}',
                '{p:[T] %}',
                '(T %)',
                'Array<T %>',
                '[T +]',
                '`${a % b}`',
                '0x',
                '[0x]',
                '0b',
                '[0b]',
                '0o',
                '[0o]',
                'T %',
                'T +',
                'T !',
                'T @',
                '[a?.b]',
                '{p:a?.b}',
                '(a?.b)',
                'Array<a?.b>',
                'T extends U ? [a?.b]:c',
                'a?.b',
                'a ?.b',
                'a?.b ? c : d',
                'T extends U ? a?.b:c',
                'new',
                'new /* incomplete */',
                'abstract new',
                'import',
                'import /* incomplete */',
                '"abc',
                "'abc",
                '`abc',
              ]
            : continuation === ')'
              ? [
                  ',,)',
                  ', /* missing parameter */ ,)',
                  ', other:T,,)',
                  ', a b)',
                  ', a b c)',
                  ', ...a b)',
                  ', a? b)',
                  ', ?)',
                  ', 1)',
                  ', :x)',
                  ', .)',
                  ', ..)',
                  ', ...)',
                  ', ... /* missing */ )',
                ]
              : [''];
        for (const replacement of [...incomplete, continuation]) {
          const tree = parser.parse(source.slice(0, start) + replacement + source.slice(start + continuation.length))!;
          try {
            expect(tree.rootNode.hasError).toBe(replacement !== continuation);
            expect(
              bindings
                .captures(tree.rootNode)
                .filter(({ node }) => node.text === name)
                .map(({ node }) => node.text)
            ).toEqual(replacement !== continuation ? [] : [name]);
          } finally {
            tree.delete();
          }
        }
      }
    } finally {
      bindings.delete();
      parser.delete();
    }
  });

  test.each(['unknown', 'never', 'unique'])(
    'retains %s canonical recovery after a modifier group followed by a non-arrow equals',
    (name) => {
      const parser = new Parser().setLanguage(language);
      try {
        for (const operand of ['(public)', '(public x)', 'typeof x(public)', 'x(public)']) {
          for (const tail of ['=x', '==x', '=', '=/*c*/x', '=/*c*/>T']) {
            const source = `type F=(${name})=>${operand}${tail}`;
            const actual = parser.parse(source)!;
            const reference = parser.parse(source.replace(name, 'x'.repeat(name.length)))!;
            try {
              expect(snapshot(actual.rootNode)).toEqual(snapshot(reference.rootNode));
              for (const query of queries) {
                expect(query.captures(actual.rootNode).map(({ name, node }) => [name, snapshot(node)])).toEqual(
                  query.captures(reference.rootNode).map(({ name, node }) => [name, snapshot(node)])
                );
              }
            } finally {
              actual.delete();
              reference.delete();
            }
          }
        }
      } finally {
        parser.delete();
      }
    }
  );

  test.each(['unknown', 'never'])('preserves declarations after malformed type returns for %s', (name) => {
    const parser = new Parser().setLanguage(language);
    const tail = 'export function f(){}\ntype B=2;';
    try {
      for (const optional of ['', '?']) {
        for (const operand of [
          '(typeof 1)',
          'infer<1>',
          'infer[T]',
          '(void,1)',
          '(x&&y)',
          '(x||y)',
          '(x??y)',
          'asserts class',
          'asserts void',
          '(asserts as)',
          '(let & T)',
          '(new . x)',
          'new(void,1)=>T',
          'new(number,()=>T)=>T',
          'new((x)=>T)=>T',
          '(...x)',
          '(x=keyof x)=>T',
          '(x=x x)=>T',
          '(()=>(unique))',
          '([1=])',
          'asserts f<typeof x(unique)>',
          'new(typeof x[])=>t',
          '(=((import)))=>l',
          '(typeof import("m") | number)',
          'asserts is typeof y',
          '(void is T)',
          '(-1 is T)',
          '(+1 is T)',
          'new(x?=0)=>void',
          '(...x=y=0)=>T',
          '(...x=y as T=0)=>void',
          '(...x=y.z=0)=>void',
          '(...x=(y)=0)=>void',
          '(...x.y=y=0)=>void',
          'new(x[0]?=1)=>void',
          'new(({x})?=1)=>void',
          'new({p:this})=>T',
          'new({p:()=>T}?=1)=>void',
          '(abstract -1 is T)',
          '(unique is keyof)',
          '(()=>unique is new)',
          '(()=>asserts\n<T>)',
          '(()=>asserts/*\n*/<T>)',
          '(Foo\n<T>)',
          '(()=>Foo.Bar/*\n*/<T>)',
          '({x:typeof is})',
          '([{x:typeof is}])',
          ...(dialect === 'typescript' ? ['(infer is x<T>)[]'] : []),
          'Array<unique asserts>',
          '{x:infer T[] is T}',
          '(()=>(({unknown})=>T))',
          '({p:(number)})=>T',
          '({p:[number,...x]})=>T',
          '(new () => void is T)',
          '(new (x) => void is T)',
          '(()=>asserts[T])',
          '((x:T)=>asserts.x)',
          '(void "x")',
          '(typeof x is typeof y)',
          '(typeof x<T> is T)',
          'readonly is typeof y',
          '(()=>x ? T : T)',
          'asserts unique symbol',
          '(asserts[unique])',
          '(()=>(unique | T))',
          'new(T|U[])=>T',
          '([x?])',
          '(new([this])=>T)',
          '(new([...x=1])=>T)',
          '(new([Foo<T>])=>T)',
          '({x:typeof import("m") | number})',
          '((typeof import("m")) | number)',
        ]) {
          const prefix = `type F<T>=T extends (${name}${optional})=>${operand} ?.5:false;\n`;
          const actual = parser.parse(prefix + tail)!;
          const reference = parser.parse(prefix.replaceAll(/[^\r\n\u2028\u2029]/g, ' ') + tail)!;
          try {
            expect(actual.rootNode.hasError, operand).toBe(true);
            const following = actual.rootNode.namedChildren.filter((node) => node.startIndex >= prefix.length);
            expect(following.map(snapshot), operand).toEqual(reference.rootNode.namedChildren.map(snapshot));
            for (const query of queries) {
              expect(
                query
                  .captures(actual.rootNode)
                  .filter(({ node }) => node.startIndex >= prefix.length)
                  .map(({ name, node }) => [name, snapshot(node)]),
                operand
              ).toEqual(query.captures(reference.rootNode).map(({ name, node }) => [name, snapshot(node)]));
            }
          } finally {
            actual.delete();
            reference.delete();
          }
        }
      }
    } finally {
      parser.delete();
    }
  });

  test.each(['unknown', 'never'])('preserves ordinary predicate recovery boundaries for %s', (name) => {
    const parser = new Parser().setLanguage(language);
    const prefix = `type F=(${name})=>(T is readonly);\n`;
    const tail = 'export function g(){}\ntype B=2;';
    const actual = parser.parse(prefix + tail)!;
    const reference = parser.parse(' '.repeat(prefix.length - 1) + '\n' + tail)!;
    try {
      expect(actual.rootNode.hasError).toBe(true);
      expect(actual.rootNode.namedChildren.filter((node) => node.startIndex >= prefix.length).map(snapshot)).toEqual(
        reference.rootNode.namedChildren.map(snapshot)
      );
      for (const query of queries) {
        expect(
          query
            .captures(actual.rootNode)
            .filter(({ node }) => node.startIndex >= prefix.length)
            .map(({ name, node }) => [name, snapshot(node)])
        ).toEqual(query.captures(reference.rootNode).map(({ name, node }) => [name, snapshot(node)]));
      }
    } finally {
      actual.delete();
      reference.delete();
      parser.delete();
    }
  });

  test.each(['unknown', 'never'])('preserves incomplete constructor import return boundaries for %s', (name) => {
    const parser = new Parser().setLanguage(language);
    const tail = 'export function f(){}\ntype B=2;';
    try {
      for (const operand of ['(new(x)=>readonly import)', '(new(x)=>keyof import)', '(new(x)=>import)']) {
        for (const ending of ['? .5 : false;', '? true:false;', '? T : false;']) {
          const prefix = `type F<T> = T extends (${name})=>${operand} ${ending}\n`;
          const actual = parser.parse(prefix + tail)!;
          const reference = parser.parse(' '.repeat(prefix.length - 1) + '\n' + tail)!;
          try {
            expect(actual.rootNode.hasError).toBe(true);
            expect(
              actual.rootNode.namedChildren.filter((node) => node.startIndex >= prefix.length).map(snapshot)
            ).toEqual(reference.rootNode.namedChildren.map(snapshot));
            for (const query of queries) {
              expect(
                query
                  .captures(actual.rootNode)
                  .filter(({ node }) => node.startIndex >= prefix.length)
                  .map(({ name, node }) => [name, snapshot(node)])
              ).toEqual(query.captures(reference.rootNode).map(({ name, node }) => [name, snapshot(node)]));
            }
          } finally {
            actual.delete();
            reference.delete();
          }
        }
      }
    } finally {
      parser.delete();
    }
  });

  test.each(['unknown', 'never', 'unique'])('retains bindings before a trailing unfinished comment for %s', (name) => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const operand of ['typeof x(public)', 'x(public)']) {
        for (const tail of ['/*', '/*x', '/*x\ntype B=2;', '/**/']) {
          const source = `type F=(${name})=>${operand}${tail}`;
          const actual = parser.parse(source)!;
          const reference = parser.parse(source.replace(name, 'x'.repeat(name.length)))!;
          try {
            expect(actual.rootNode.descendantsOfType('function_type')).toHaveLength(1);
            expect(snapshot(actual.rootNode)).toEqual(snapshot(reference.rootNode));
            for (const query of queries) {
              expect(query.captures(actual.rootNode).map(({ name, node }) => [name, snapshot(node)])).toEqual(
                query.captures(reference.rootNode).map(({ name, node }) => [name, snapshot(node)])
              );
            }
          } finally {
            actual.delete();
            reference.delete();
          }
        }
      }
    } finally {
      parser.delete();
    }
  });

  test.each(['unknown', 'never', 'unique'])(
    'retains bindings in conditional types and return statement boundaries for %s',
    (name) => {
      const parser = new Parser().setLanguage(language);
      try {
        for (const source of [
          `type F<T> = T extends (${name})=>typeof x[] ?.5:false;`,
          `type F=(${name})=>((any))\nimport {x} from "x";`,
          `type F<T> = T extends (${name})=>typeof x["y"] ?.5:false;`,
          `type F<T> = T extends (${name})=>typeof x<1> ?.5:false;`,
          `type F<T> = T extends (${name})=>typeof x | number ?.5:false;`,
          `type F<T> = T extends (${name})=>typeof x & number ?.5:false;`,
          `type F<T> = T extends (${name})=>asserts x is typeof y | number ?.5:false;`,
          `type F<T> = T extends (${name})=>asserts is[T] ?.5:false;`,
          `type F<T> = T extends (${name})=>{x:typeof import("m").T} ?.5:false;`,
          `type F<T> = T extends (${name})=>([unknown?]) ?.5:false;`,
          `type F<T> = T extends (${name})=>([T[]?]) ?.5:false;`,
          `type F<T> = T extends (${name})=>new([x=1,...y])=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>new(x=0)=>void ?.5:false;`,
          `type F<T> = T extends (${name})=>new(x?:T)=>void ?.5:false;`,
          `type F<T> = T extends (${name})=>(x=y=0)=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>((x:T)=>(typeof import("m")) | number) ?.5:false;`,
          `type F<T> = T extends (${name})=>([[x]?]) ?.5:false;`,
          `type F<T> = T extends (${name})=>([{x}?]) ?.5:false;`,
          `type F<T> = T extends (${name})=>new([...this.x])=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>new(...this.x)=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>new([x]?=1)=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>new([x]?=1)=>void ?.5:false;`,
          `type F<T> = T extends (${name})=>new({p:x,q}?=1)=>void ?.5:false;`,
          `type F<T> = T extends (${name})=>new({p:[unknown]}?=1)=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>new({p:x=0}?=1)=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>new({p:[x]})=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>(()=>infer is "x") ?.5:false;`,
          `type F<T> = T extends (${name})=>()=>asserts is is is ?.5:false;`,
          String.raw`type F<T> = T extends (${name})=>()=>\u0078 is T ?.5:false;`,
          `type F<T> = T extends (${name})=>asserts unique symbol is T ?.5:false;`,
          `type F<T> = T extends (${name})=>(()=>asserts unique symbol is T) ?.5:false;`,
          `type F<T> = T extends (${name})=>(new()=>()=>x is T) ?.5:false;`,
          `type F<T> = T extends (${name})=>(new()=>infer is) ?.5:false;`,
          `type F<T> = T extends (${name})=>(()=>asserts<T>) ?.5:false;`,
          `type F<T> = T extends (${name})=>(()=>asserts/* gap */<T>) ?.5:false;`,
          `type F<T> = T extends (${name})=>(()=>typeof foo\n<T>) ?.5:false;`,
          `type F<T> = T extends (${name})=>((x:T)=>asserts<T>[]) ?.5:false;`,
          `type F<T> = T extends (${name})=>(new)=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>{x:typeof is} ?.5:false;`,
          `type F<T> = T extends (${name})=>({p:()=>T,q:{x:typeof is}}) ?.5:false;`,
          `type F<T> = T extends (${name})=>([()=>T,{x:typeof is}]) ?.5:false;`,
          `type F<T> = T extends (${name})=>(asserts[unique symbol]) ?.5:false;`,
          `type F<T> = T extends (${name})=>(x[0]?)=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>(()=>infer is extends T ? X : Y) ?.5:false;`,
          `type F<T> = T extends (${name})=>((x?:T=0)=>T) ?.5:false;`,
          `type F<T> = T extends (${name})=>import("x").T ?.5:false;`,
          `type F<T> = T extends (${name})=>import("x").T<Y> ?.5:false;`,
          `type F<T> = T extends (${name})=>Array<import("x").T> ?.5:false;`,
          `type F<T> = T extends (${name})=>{number<X>(): X} ?.5:false;`,
          `type F<T> = T extends (${name})=>Array<typeof x().y> ?.5:false;`,
          `type F<T> = T extends (${name})=>(typeof x())[] ?.5:false;`,
          `type F<T> = T extends (${name})=>(await) ?.5:false;`,
          `type F<T> = T extends (${name})=>typeof x(public) ? .5:false;`,
          `type F=(${name})=>typeof x(public);`,
          `type F<T> = T extends (${name})=>typeof x((public))[] ?.5:false;`,
          `type F<T> = T extends (${name})=>typeof x(public as T)[] ?.5:false;`,
          `type F<T> = T extends (${name})=>typeof x(public[0])[] ?.5:false;`,
          `type F<T> = T extends (${name})=>typeof x((public readonly x=0)=>T)[] ?.5:false;`,
          `type F<T> = T extends (${name})=>typeof x(y(x))[] ?.5:false;`,
          `type F<T> = T extends (${name})=>typeof x((x as T))[] ?.5:false;`,
          `type F<T> = T extends (${name})=>typeof x((x: typeof fn(y(x))[])=>x)[] ?.5:false;`,
          `type F<T> = T extends (${name})=>(public x)=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>(public readonly x=0)=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>(x=0,y)=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>(x=0,)=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>new(x=abstract)=>(1n) ?.5:false;`,
          `type F<T> = T extends (${name})=>(x=abstract,y)=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>(x=0 as abstract)=>T ?.5:false;`,
          String.raw`type F<T> = T extends (${name})=>(x=0 as keyof \u0078)=>T ?.5:false;`,
          String.raw`type F=(${name})=>(x=0 as typeof \u{78})=>T;`,
          `type F<T> = T extends (${name})=>(x=new C)=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>(x=as)=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>(x=satisfies,)=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>(infer:T)=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>typeof x((x&&y))[] ?.5:false;`,
          `type F<T> = T extends (${name})=>((y)=x,z)=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>((x:T)=>x is abstract) ?.5:false;`,
          `type F<T> = T extends (${name})=>(()=>asserts is) ?.5:false;`,
          `type F<T> = T extends (${name})=>asserts void is T ?.5:false;`,
          `type F<T> = T extends (${name})=>(()=>asserts void is T) ?.5:false;`,
          `type F<T> = T extends (${name})=>(type)=>number ?.5:false;`,
          `type F<T> = T extends (${name})=>(type | number) ?.5:false;`,
          `type F<T> = T extends (${name})=>(let)=>number ?.5:false;`,
          `type F<T> = T extends (${name})=>new((1))=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>new((()=>T))=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>new(x:()=>T)=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>(x=keyof in obj)=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>(x=keyof as T)=>T ?.5:false;`,

          `type F<T> = T extends (${name})=>new()=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>new(x)=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>Array<new(x=1)=>T> ?.5:false;`,
          `type F<T> = T extends (${name})=>newπ<T> ?.5:false;`,
          String.raw`type F<T> = T extends (${name})=>Array<new\u{78}[]> ?.5:false;`,
          `type F<T> = T extends (${name})=>keyof (()=>number) ?.5:false;`,
          `type F<T> = T extends (${name})=>(keyof typeof abstract) ?.5:false;`,
          `type F<T> = T extends (${name})=>(readonly readonly typeof abstract) ?.5:false;`,
          `type F<T> = T extends (${name})=>abstract new()=>T ?.5:false;`,
          `type F<T> = T extends (${name})=>(x: T)=>U ?.5:false;`,
          `type F<T> = T extends (${name})=>(number) ?.5:false;`,
          `type F<T> = T extends (${name})=>number ?.5:false;`,
          `type F<T> = T extends (${name}?)=>number ?.5:false;`,
          `type F<T> = T extends (${name}?)=>number ? true:false;`,
          `type F<T> = T extends <U>(${name})=>U ?.5:false;`,
          `type F<T> = T extends (first: string, ${name}, last: number)=>number ?.5:false;`,
          `type F<T> = T extends (${name})=>(U extends V ? string : number) ?.5:false;`,
          `type F<T> = T extends (x: string, ${name})=>asserts ${name} | V ?.5:false;`,
          `type F<T> = T extends (x, ${name})=>asserts ${name} & V ?.5:false;`,
          `type F<T> = T extends (x: string, ${name}?)=>asserts ${name} | V ?.5:false;`,
          `type F<T> = T extends <G>(${name})=>asserts ${name} | V ?.5:false;`,
          `type F<T> = T extends <G>(${name})=>asserts ${name} & V ?.5:false;`,
          `type F<T> = T extends <G>(${name}?)=>asserts ${name} | V ?.5:false;`,
          `type F<T> = T extends (${name})=>asserts ${name} | V ? true:false;`,
          `type F<T> = T extends (${name})=>asserts ${name} & V ? true:false;`,
          `type F<T> = T extends (${name}?)=>asserts ${name} | V ? true:false;`,
          `type F<T> = T extends (${name})=>number ? true:false;`,
          `type F<T> = T extends (${name})=>infer R ? R:never;`,
          `type F=(${name})=>new()=>T;`,
          `type F=(${name})=>abstract new()=>T;`,
          `type F=(${name})=>import("x").T;`,
          `type F=(${name})=>number\n/foo/.test("");`,
          `type F=(${name})=>abstract\nnumber;`,
          `type F=(${name})=>number\n@dec class C {}`,
          `type F=(${name})=>number /*\n*/ @dec class C {}`,
          `type F=(${name})=>number\nimport "x";`,
          `type F=(${name})=>abstract\nimport "x";`,
          `type F=(${name})=>(number)\nimport {x} from "x";`,
        ]) {
          const ordinary = source.replace(name, 'x'.repeat(name.length));
          const actual = parser.parse(source)!;
          const reference = parser.parse(ordinary)!;
          try {
            expect(actual.rootNode.hasError, source).toBe(false);
            expect(snapshot(actual.rootNode)).toEqual(snapshot(reference.rootNode));
            for (const query of queries) {
              expect(query.captures(actual.rootNode).map(({ name, node }) => [name, snapshot(node)])).toEqual(
                query.captures(reference.rootNode).map(({ name, node }) => [name, snapshot(node)])
              );
            }
          } finally {
            actual.delete();
            reference.delete();
          }
        }
      } finally {
        parser.delete();
      }
    }
  );

  test.each([
    ['function f<X>(x: X extends infer U extends U ?.5): void {}\ntype B = 2;', 'function_declaration'],
    ['const a = { m(x: X extends infer U extends U ?.5) {} };\ntype B = 2;', 'lexical_declaration'],
  ])('preserves declarations around complete and incomplete nested conditions: %s', (initial, declarationType) => {
    const parser = new Parser().setLanguage(language);
    const start = initial.indexOf('?.5') + '?.5'.length;
    try {
      for (const repair of ['', ':false']) {
        const tree = parser.parse(initial.slice(0, start) + repair + initial.slice(start))!;
        try {
          expect(tree.rootNode.namedChildren.map((node) => node.type)).toEqual([
            declarationType,
            'type_alias_declaration',
          ]);
          expect(tree.rootNode.lastNamedChild?.text).toBe('type B = 2;');
          expect(tree.rootNode.hasError).toBe(repair === '');
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });

  test.each(
    ['unknown', 'never'].flatMap((name) =>
      ['', '?'].flatMap((optional) =>
        [
          '((typeof x)<T>).y',
          '((typeof x)<T>)',
          '(void.y.z)["k"]',
          'Foo(T>U)',
          'Foo(T>U).y',
          'Foo(T=>U)',
          'Foo(bar>U)',
          '(Foo(T>U))',
          '((Foo(T>U)))',
          '(Foo(T=>U))',
          '(Foo(bar>U))',
          '(Foo(T>U)) | number',
          '((x)=>Foo(T>U))',
          '((x: string)=>Foo(T>U))',
          '(Foo(T>U)<V>)',
          '(()=>(public)=x)',
          '((x:T)=>((public)=/*c*/x))',
          '(new(public)==x)',
          '((new(public)=)=>T)',
        ].map((operand) => ({
          name,
          optional,
          operand,
        }))
      )
    )
  )(
    'preserves declarations after malformed composite returns for $name ($optional) / $operand',
    ({ name, optional, operand }) => {
      const parser = new Parser().setLanguage(language);
      const source = `type F<T> = T extends (${name}${optional})=>${operand} ?.5:false;\nexport function f(x: number): number { return x; }\ntype B = 2;`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError).toBe(true);
        checkFollowingDeclarations(tree, 'export function f(x: number): number { return x; }', 'type B = 2;');
      } finally {
        tree.delete();
        parser.delete();
      }
    }
  );

  test.each([
    '(x as const)',
    '(x satisfies X)',
    '(delete)',
    '(x => y)',
    '(()=>asserts in)',
    '(null<T>)',
    '(0<T>)',
    '("x"<T>)',
    '(`x${T}`<U>)',
    '([T]<U>)',
    '({}<U>)',
    '(this<U>)',
    '(import("x").T<T>)',
    '(typeof foo.number<X>())',
    '(typeof x["x"]<T>)',
    '(typeof x(T>U)<V>)',
    '(typeof abstract.Foo)',
    '(readonly typeof abstract)',
    '(typeof import("x").T)',
    '(typeof import("x").T<U>)',
    '(typeof this<T>)',
    'keyof ()=>number',
    'keyof new()=>T',
    'new (number)',
  ])('preserves declarations after unsupported composite type operands: %s', (operand) => {
    const parser = new Parser().setLanguage(language);
    const source = `type F<T> = T extends (unknown)=>${operand} ?.5:false;\nexport function f(){}\ntype B=2;`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(true);
      checkFollowingDeclarations(tree, 'export function f(){}', 'type B=2;');
    } finally {
      tree.delete();
      parser.delete();
    }
  });

  test.each([
    'type F<T> = T extends (unknown)=>(x: T)=>typeof x().y[]<U> ? .5:false;',
    'type F<T> = T extends (((infer)=>unique)) ? .5 : false;',
  ])('preserves declarations after invalid conditional types: %s', (prefix) => {
    const parser = new Parser().setLanguage(language);
    const source = `${prefix}\n\nexport function f(x: number): number { return x; }\ntype B = 2;`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(true);
      checkFollowingDeclarations(tree, 'export function f(x: number): number { return x; }', 'type B = 2;');
    } finally {
      tree.delete();
      parser.delete();
    }
  });

  test.each([
    'type F<T> = T extends (unknown)=>unique ? .5:false;',
    'type F<T> = T extends (unknown)=>keyof ? .5:false;',
    'type F<T> = T extends (unknown)=>typeof ? true:false;',
    'type F<T> = T extends (z: number, unknown)=>readonly ? .5:false;',
  ])('preserves the alias around an invalid conditional operand: %s', (source) => {
    const parser = new Parser().setLanguage(language);
    const aliases = new Query(language, '(type_alias_declaration name: (type_identifier) @name)');
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(true);
      expect(tree.rootNode.namedChildren.map((node) => node.type)).toEqual(['type_alias_declaration']);
      expect(aliases.captures(tree.rootNode).map(({ node }) => node.text)).toEqual(['F']);
    } finally {
      tree.delete();
      aliases.delete();
      parser.delete();
    }
  });

  test.each(
    ['unknown', 'never'].flatMap((name) =>
      ['V', String.raw`\u0078`, String.raw`\u{78}`, String.raw`x\u{200C}`, 'π', 'x\u200D'].map((operand) => ({
        name,
        operand,
      }))
    )
  )('preserves declarations after decimal type-query consequences for $name / $operand', ({ name, operand }) => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const spacing of [' ', '']) {
        const tree = parser.parse(
          `type A = 1;\ntype X = T extends (${name})=>typeof ${operand} ?${spacing}.5:false;\nexport function f(x: number): number { return x; }\ntype B = 2;`
        )!;
        try {
          expect(tree.rootNode.hasError).toBe(spacing === '');
          expect(tree.rootNode.namedChildren.map((node) => node.type)).toEqual([
            'type_alias_declaration',
            'type_alias_declaration',
            'export_statement',
            'type_alias_declaration',
          ]);
          expect(tree.rootNode.namedChildren.slice(2).map((node) => node.text)).toEqual([
            'export function f(x: number): number { return x; }',
            'type B = 2;',
          ]);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });

  test.each(['unknown', 'never', 'unique'])(
    'keeps conditional probes local after complete and incomplete preceding conditionals for %s',
    (name) => {
      const parser = new Parser().setLanguage(language);
      const bindings = new Query(language, '(required_parameter pattern: (pattern/identifier) @name)');
      const prefix = 'type Earlier = T extends ';
      try {
        for (const [suffix, expectedNames] of [
          [`type F<T> = T extends (${name})=>number ?.5:false;`, [name]],
          [`type F = (${name})=>number ?.5:false;`, []],
          [`type F<T> = T extends {p:(${name})=>number ?.5:false} ? true:false;`, []],
        ] as const) {
          for (const repair of ['', 'U ? 1 : 0']) {
            const tree = parser.parse(`${prefix}${repair}; ${suffix}`)!;
            try {
              expect(bindings.captures(tree.rootNode).map(({ node }) => node.text)).toEqual(expectedNames);
            } finally {
              tree.delete();
            }
          }
        }
      } finally {
        bindings.delete();
        parser.delete();
      }
    }
  );

  test.each([
    '{[a % b]: number}',
    '{[(a % b)]: number}',
    '{p:-5}',
    '[-5,T]',
    '{p:-1.5e-3;q:T}',
    'T extends U ? -5:V',
    '{-readonly [K in keyof T]+?:T[K]}',
    '(x=a % b)=>U',
    '(x:T=a % b)=>U',
    '(x=a?.b)=>U',
    '(x:T=a?.b)=>U',
    '(x=(a,b % c))=>U',
    '(x=fn(a,b % c))=>U',
    '{f(x=a % b):U}',
    '{[a?.b]: number}',
    'T extends U ?.12345678901234567890e-2:V',
    'is',
    'T | is',
    'T & is',
    'x is is',
    'asserts is',
    'asserts x is is',
    'keyof is',
    'typeof is',
    'infer is',
    'readonly is[]',
    '(readonly)=>U',
    '{readonly}',
    '{keyof}',
    '{typeof}',
    '{infer}',
    '{new}',
    '{import}',
    '<T>(readonly,x)=>U',
    '<T>(keyof,x)=>U',
    '<T>(infer,x)=>U',
    '{f(readonly,x):U}',
    '{f(keyof,x):U}',
    '{f(infer,x):U}',
    '<T>(readonly?,x?)=>U',
    '<T>(keyof?,x?)=>U',
    '<T>(infer?,x?)=>U',
    '{f(readonly?,x?):U}',
    '{f(keyof?,x?):U}',
    '{f(infer?,x?):U}',
    '(x=a ? b : c)=>U',
    '(x=a ?? b)=>U',
    '(x=a?.extends)=>U',
    '(x=a?.())=>U',
    '(x:T=a?.())=>U',
    '{m(x=a?.()):void}',
    '{[K in T]-?:(x=a?.())=>U}',
    '(x=a?.b?.())=>U',
    '(x=a ? b?.():c)=>U',
    '(x=a?.<string>())=>U',
    '(x={extends:a})=>U',
    '(x=class extends T {})=>U',
    '(x=class C extends T {})=>U',
    '(x=class C<T extends U> extends V {})=>U',
    '(x=fn<T extends U ? V:W>())=>U',
    '(x=(a:T extends U ? V:W)=>a)=>U',
    '(x=a as (T extends U ? V:W))=>U',
    '(x=a satisfies (T extends U ? V:W))=>U',
    '(x=function F<T extends U>(a:T){return a})=>U',
    '(x=async function F<T extends U>(a:T){return a})=>U',
    '(x={m():T extends U ? V:W{return a}})=>U',
    '(x=a ? b:c.extends)=>U',
    '(x=a ? b:c?.readonly)=>U',

    'T extends U ? T:is',
    '(x:T)=>is',
    'keyof asserts',
    'typeof infer',
    'infer keyof',
    'extends',
    'T | extends',
    'x is extends',
    'typeof extends',
    'infer extends',
    'T extends extends ? T:extends',
    '(x:T)=>extends',
    'T.is<U>',
    'T.is<U>[]',
    'x is T.is<U>',
    'asserts x is T.is<U>',
    'infer R extends U',
    'infer R extends infer U extends V',
    'infer R extends U ? A:B',
    'T extends infer R extends U ? R:V',
    'T extends U ?.5:c',
    'T extends U ?.0:c',
    '(T extends U ?.5:c)',
    '(extends)',
    '(infer R extends U)',
    '[T extends U ? extends:V]',
    '[T extends U ? V:T.extends<U>]',
    '<R extends U>(x:R)=>R',
    '{p:T extends U ? {}:W}',
    '{p:T extends U ? []:W}',
    '{p:T extends U ? (V):W}',
    '<R extends T extends U ? {}:W>()=>R',
    '{p:T extends U ? V:W;}',
    '{p:T extends U ? V:W,}',
    '[(x:T extends U ? V:W,)=>U]',
  ])('retains contextual return %s and its renamed result', (result) => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const generic of ['', '<T>']) {
        for (const optional of ['', '?']) {
          for (const name of ['unknown', 'never', 'unique']) {
            for (const trivia of ['', ' /* c */ ', '\n']) {
              const source = `type is=number;type F=${generic}(${name}${optional})=>${trivia}${result};`;
              const tree = parser.parse(source)!;
              const reference = parser.parse(source.replace(name, 'x'.repeat(name.length)))!;
              const identifiers = result.match(/[A-Za-z_$][\w$]*/g)!;
              const target = result.endsWith('extends')
                ? 'extends'
                : identifiers.includes('is')
                  ? 'is'
                  : identifiers.at(-1)!;
              const start = source.lastIndexOf(target);
              const renamed = parser.parse(source.slice(0, start) + 'Result' + source.slice(start + target.length))!;
              try {
                expect(tree.rootNode.hasError, source).toBe(false);
                expect(snapshot(tree.rootNode), source).toEqual(snapshot(reference.rootNode));
                for (const query of queries) {
                  expect(query.captures(tree.rootNode).map(({ name, node }) => [name, snapshot(node)])).toEqual(
                    query.captures(reference.rootNode).map(({ name, node }) => [name, snapshot(node)])
                  );
                }
                expect(renamed.rootNode.hasError, source).toBe(false);
              } finally {
                tree.delete();
                reference.delete();
                renamed.delete();
              }
            }
          }
        }
      }
    } finally {
      parser.delete();
    }
  });

  test.each(['unknown', 'never'])('preserves parenthesized arrow return annotations for %s', (name) => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const parameters of ['()', '(a)']) {
        for (const trivia of ['', ' /* c */ ', '\n']) {
          for (const body of ['{}', 'a', 'number=>a']) {
            const source = `const f=${parameters}:${trivia}(${trivia}${name}${trivia})${trivia}=>${trivia}${body};`;
            checkParsed(parser, source, (tree) => {
              expect(tree.rootNode.hasError, source).toBe(false);
              const value = tree.rootNode.namedChildren[0]!.namedChildren[0]!.childForFieldName('value')!;
              expect(value?.type, source).toBe('arrow_function');
              expect(value.childForFieldName('return_type')!.namedChildren.find((node) => !node.isExtra)!.type).toBe(
                'parenthesized_type'
              );
              expect(value.childForFieldName('body'), source).not.toBeNull();
            });
          }
        }
      }
    } finally {
      parser.delete();
    }
  });

  test.each(['unknown', 'never', 'unique'])('retains function-type arrow return annotations for %s', (name) => {
    const parser = new Parser().setLanguage(language);
    const bindings = new Query(language, '(required_parameter pattern: (pattern/identifier) @name)');
    try {
      for (const parameters of ['()', '(a)', '<T>(a:T)']) {
        for (const trivia of ['', ' /* c */ ', '\n']) {
          for (const body of [
            'void=>1',
            'void=>{}',
            'extends=>1',
            'extends=>{}',
            'T extends U ?.5:c=>1',
            'T extends U ?.0:c=>{}',
            ...(name === 'unique' ? ['number=>a'] : []),
          ]) {
            const source = `const f=${parameters}:${trivia}(${trivia}${name}${trivia})${trivia}=>${trivia}${body};`;
            checkParsed(parser, source, (tree) => {
              expect(tree.rootNode.hasError, source).toBe(false);
              const value = tree.rootNode.namedChildren[0]!.namedChildren[0]!.childForFieldName('value')!;
              expect(value?.type, source).toBe('arrow_function');
              expect(value.childForFieldName('return_type')!.namedChildren.find((node) => !node.isExtra)!.type).toBe(
                'function_type'
              );
              expect(value.childForFieldName('body')!.text, source).toBe(body.slice(body.indexOf('=>') + 2));
              const start = source.indexOf(name);
              expect(
                bindings
                  .captures(tree.rootNode)
                  .filter(({ node }) => node.text === name)
                  .map(({ node }) => [node.text, node.startIndex, node.endIndex])
              ).toEqual([[name, start, start + name.length]]);
            });
          }
        }
      }
    } finally {
      bindings.delete();
      parser.delete();
    }
  });

  test('reports malformed unique return annotations and parses their repairs', () => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const parameters of ['()', '(a)', '<T>(a:T)']) {
        for (const trivia of ['', ' /* c */ ', '\n']) {
          for (const body of ['{}', 'a', 'void 0']) {
            const source = `const f=${parameters}:${trivia}(${trivia}unique${trivia})${trivia}=>${trivia}${body};`;
            checkParsed(parser, source, (tree) => {
              expect(tree.rootNode.hasError, source).toBe(true);
            });
            const repaired = parser.parse(source.replace('unique', 'number'))!;
            try {
              expect(repaired.rootNode.hasError, source).toBe(false);
              const value = repaired.rootNode.namedChildren[0]!.namedChildren[0]!.childForFieldName('value')!;
              expect(value?.type, source).toBe('arrow_function');
              expect(value.childForFieldName('body'), source).not.toBeNull();
            } finally {
              repaired.delete();
            }
          }
        }
      }
    } finally {
      parser.delete();
    }
  });

  test.each(['unknown', 'never', 'unique'])('reports incomplete arrow bodies for %s', (name) => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const parameters of ['()', '(a)', '<T>(a:T)']) {
        for (const trivia of ['', ' /* c */ ', '\n']) {
          const source = `const f=${parameters}:${trivia}(${trivia}${name}${trivia})${trivia}=>${trivia};`;
          checkParsed(parser, source, (tree) => {
            expect(tree.rootNode.hasError, source).toBe(true);
          });
        }
      }
    } finally {
      parser.delete();
    }
  });

  test.each(['unknown', 'never', 'unique'])(
    'distinguishes complete and incomplete union and rest forms for %s',
    (name) => {
      const parser = new Parser().setLanguage(language);
      const bindings = new Query(language, '(required_parameter pattern: (pattern/identifier) @name)');
      try {
        for (const [source, removed] of [
          [`type F=(${name})=>T | U;`, 'U'],
          [`type F=(${name})=>T & U;`, 'U'],
          [`type F=(${name}, ...rest)=>number;`, 'rest'],
          [`type F=(${name})=>T extends U ? T:U;`, ' ? T:U'],
          [`type F=(${name})=>T extends U ? V:W;`, 'V'],
          [`type F=(${name})=>T extends U ? V | X:W;`, 'X'],
          [`type F=(${name})=>T extends U ? V.X:W;`, 'X'],
          [`type F=(${name})=>[T extends U ? V.X:W];`, 'X'],
          [`type F=(${name})=>(T extends U ? T:U);`, ' ? T:U'],
          [`type F=(${name})=>[T extends U ? T:U];`, ' ? T:U'],
          [`type F=(${name})=>[T extends U ? V:W];`, 'W'],
          [`type F=(${name})=>[T extends U ? V:W];`, 'U'],
          [`type F=(${name})=>{p:T extends U ? T:U};`, ' ? T:U'],
          [`type F=(${name})=>{p:T extends U ? {}:W};`, '{}'],
          [`type F=(${name})=>{p:T extends U ? []:W};`, '[]'],
          [`type F=(${name})=>{p:T extends U ? (V):W};`, '(V)'],
          [`type F=(${name})=><R extends T extends U ? {}:W>()=>R;`, '{}'],
          [`type F=(${name})=>(T extends U ? (V extends W ? V:W):U);`, ' ? V:W'],
          [`type F=(${name})=>((x:T)=>T extends U ? T:U);`, ' ? T:U'],
          [`type F=(${name})=>(x:T)=>T extends U ? T:U;`, ' ? T:U'],
          [`type F=(${name})=>x is T extends U ? T:U;`, ' ? T:U'],
          [`type F=(${name})=>T extends U ? V:W extends Z ? X:Y;`, ' ? X:Y'],
          [`type F=(${name})=>x is keyof U;`, 'U'],
          [`type F=(${name})=>x is typeof U;`, 'U'],
          [`type F=(${name})=>x is infer U;`, 'U'],
          [`type F=(${name})=>x is readonly U[];`, 'U[]'],
          [`type F=(${name})=>asserts x is keyof U;`, 'U'],
          [`type F=(${name})=>asserts x is typeof U;`, 'U'],
          [`type F=(${name})=>asserts x is infer U;`, 'U'],
          [`type F=(${name})=>asserts x is readonly U[];`, 'U[]'],
        ] as const) {
          const start = source.indexOf(removed);
          for (const next of [source.slice(0, start) + source.slice(start + removed.length), source]) {
            const tree = parser.parse(next)!;
            try {
              expect(tree.rootNode.hasError, next).toBe(next !== source);
              expect(
                bindings
                  .captures(tree.rootNode)
                  .filter(({ node }) => node.text === name)
                  .map(({ node }) => node.text)
              ).toEqual(next !== source ? [] : [name]);
            } finally {
              tree.delete();
            }
          }
        }
      } finally {
        bindings.delete();
        parser.delete();
      }
    }
  );

  test.each(['unknown', 'never', 'unique'])('retains canonical bindings for %s', (name) => {
    const parser = new Parser().setLanguage(language);
    const bindings = new Query(
      language,
      '[(required_parameter pattern: (pattern/identifier) @name) (optional_parameter pattern: (pattern/identifier) @name)]'
    );
    try {
      for (const generic of ['', '<T>']) {
        for (const optional of ['', '?']) {
          for (const trivia of ['', ' /* binding */ ', '\n']) {
            for (const header of [
              'BINDING',
              'BINDING, other:T',
              'other:T, BINDING',
              'BINDING, other?:T',
              'BINDING, other?, third?',
              'BINDING, other?,',
            ]) {
              const parameters = header.replace('BINDING', name + trivia + optional);
              const source = `type F=${generic}(${parameters})=>unknown;`;
              const start = source.indexOf(name),
                end = start + name.length;
              const ordinary = source.slice(0, start) + 'x'.repeat(name.length) + source.slice(end);
              const reference = parser.parse(ordinary)!;
              let tree: Tree | undefined;
              try {
                expect(reference.rootNode.hasError).toBe(false);
                tree = parser.parse(source)!;
                expect(tree.rootNode.hasError).toBe(false);
                expect(snapshot(tree.rootNode)).toEqual(snapshot(reference.rootNode));
                for (const query of queries) {
                  expect(query.captures(tree.rootNode).map(({ name, node }) => [name, snapshot(node)])).toEqual(
                    query.captures(reference.rootNode).map(({ name, node }) => [name, snapshot(node)])
                  );
                }
                expect(
                  bindings
                    .captures(tree.rootNode)
                    .filter(({ node }) => node.text === name)
                    .map(({ node }) => [node.startIndex, node.endIndex])
                ).toEqual([[start, end]]);
                const renamed = parser.parse(source.slice(0, start) + 'argument' + source.slice(end))!;
                try {
                  expect(renamed.rootNode.hasError).toBe(false);
                  expect(
                    bindings
                      .captures(renamed.rootNode)
                      .filter(({ node }) => node.text === 'argument')
                      .map(({ node }) => [node.startIndex, node.endIndex])
                  ).toEqual([[start, start + 'argument'.length]]);
                } finally {
                  renamed.delete();
                }
              } finally {
                tree?.delete();
                reference.delete();
              }
            }
          }
        }
      }
    } finally {
      bindings.delete();
      parser.delete();
    }
  });
});

function checkParsed(parser: Parser, source: string, check: (tree: Tree) => void): void {
  const tree = parser.parse(source)!;
  try {
    check(tree);
  } finally {
    tree.delete();
  }
}

function snapshot(node: Node): unknown {
  return [
    node.type,
    node.grammarType,
    node.isNamed,
    node.isMissing,
    node.isExtra,
    node.hasError,
    node.startIndex,
    node.endIndex,
    node.startPosition,
    node.endPosition,
    node.children.map((_, index) => node.fieldNameForChild(index)),
    node.children.map(snapshot),
  ];
}

function checkFollowingDeclarations(tree: Tree, functionSource: string, aliasSource: string): void {
  expect(tree.rootNode.namedChildren.slice(-2).map((node) => [node.type, node.text, node.hasError])).toEqual([
    ['export_statement', functionSource, false],
    ['type_alias_declaration', aliasSource, false],
  ]);
}
