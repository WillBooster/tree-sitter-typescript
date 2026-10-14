import { Edit, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { compareEditedTree, position } from '../helpers/treeEdit.js';
import { loadCurrentWasmBuild } from './wasmBuild.js';

const Names = [
  { name: 'infer', optional: '', returnType: 'U' },
  { name: 'infer', optional: '?', returnType: 'U' },
  { name: 'readonly', optional: '?', returnType: 'U' },
  { name: 'keyof', optional: '', returnType: 'U' },
  { name: 'keyof', optional: '?', returnType: 'U' },
  ...['string', 'string[]', 'number | string'].map((type) => ({
    name: 'infer',
    optional: '',
    returnType: `infer is ${type}`,
  })),
  ...['string', 'string[]', 'unique symbol', 'number | string'].map((type) => ({
    name: 'keyof',
    optional: '',
    returnType: `keyof is ${type}`,
  })),
];
const Contexts = [
  'type F=SIGNATURE;',
  'type F=(x:SIGNATURE)=>void;',
  'type F=(unknown:SIGNATURE)=>void;',
  'type F=Array<SIGNATURE>;',
  'type F={f(x:SIGNATURE):void};',
  'type F=(unknown)=>SIGNATURE;',
];

describe.each(['typescript', 'tsx'])('%s contextual function-type parameter names', (dialect) => {
  let language: Awaited<ReturnType<typeof loadCurrentWasmBuild>>;
  let query: Query | undefined;
  beforeAll(async () => {
    await Parser.init();
    language = await loadCurrentWasmBuild(dialect);
    query = new Query(
      language,
      `
      (type/function_type) @signature
      [(required_parameter pattern: (pattern/identifier) @binding)
       (optional_parameter pattern: (pattern/identifier) @binding)]
    `
    );
  }, 30_000);
  afterAll(() => query?.delete());

  test.each(Names)(
    'keeps $name ($optional) bindings with $returnType through annotation edits',
    ({ name, optional, returnType }) => {
      const parser = new Parser().setLanguage(language);
      try {
        for (const context of Contexts) {
          for (const trivia of ['', ' /* name */ ', '\n']) {
            for (const annotation of ['T', 'typeof ns.x', 'readonly T[]', 'T extends U?V:W']) {
              let source = context.replace('SIGNATURE', `(${name}${optional}${trivia}:${annotation})=>${returnType}`);
              const nameStart = source.indexOf(name);
              const start = source.indexOf(':', nameStart + name.length) + 1;
              let previousAnnotation = annotation;
              let tree: Tree | undefined;
              const checkBinding = (current: Tree): void => {
                const captures = query!.captures(current.rootNode);
                const bindings = captures.filter(
                  ({ name: capture, node }) => capture === 'binding' && node.text === name
                );
                expect(bindings.map(({ node }) => [node.startIndex, node.endIndex])).toEqual([
                  [nameStart, nameStart + name.length],
                ]);
                const parameter = bindings[0]!.node.parent!;
                expect(parameter.type).toBe(optional ? 'optional_parameter' : 'required_parameter');
                expect(parameter.childForFieldName('type')?.text).toBe(`:${annotation}`);
                const signature = parameter.parent!.parent!;
                expect(signature.type).toBe('function_type');
                expect(signature.childForFieldName('return_type')?.text).toBe(returnType);
                expect(
                  captures.some(({ name: capture, node }) => capture === 'signature' && node.id === signature.id)
                ).toBe(true);
              };
              try {
                tree = parser.parse(source)!;
                expect(tree.rootNode.hasError).toBe(false);
                checkBinding(tree);
                for (const replacement of ['', '/* removed */', annotation]) {
                  const end = start + previousAnnotation.length;
                  const next = source.slice(0, start) + replacement + source.slice(end);
                  const previous = tree;
                  tree = compareEditedTree(
                    parser,
                    previous,
                    next,
                    new Edit({
                      startIndex: start,
                      oldEndIndex: end,
                      newEndIndex: start + replacement.length,
                      startPosition: position(source, start),
                      oldEndPosition: position(source, end),
                      newEndPosition: position(next, start + replacement.length),
                    }),
                    (incremental, fresh) => {
                      for (const current of [incremental, fresh]) {
                        expect(current.rootNode.hasError).toBe(replacement !== annotation);
                        if (replacement === annotation) checkBinding(current);
                      }
                    },
                    true
                  );
                  previous.delete();
                  source = next;
                  previousAnnotation = replacement;
                }
              } finally {
                tree?.delete();
              }
            }
          }
        }
      } finally {
        parser.delete();
      }
    }
  );
});
