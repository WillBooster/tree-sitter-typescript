import { Parser } from '@willbooster/web-tree-sitter';
import { beforeAll, describe, expect, test } from 'vitest';

import { parameterBindingIdentifiers } from '../helpers/nodeRoles.js';
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
  beforeAll(async () => {
    await Parser.init();
    language = await loadCurrentWasmBuild(dialect);
  }, 30_000);

  test.each(Names)(
    'keeps $name ($optional) bindings with $returnType and rejects missing annotations',
    ({ name, optional, returnType }) => {
      const parser = new Parser().setLanguage(language);
      try {
        for (const context of Contexts) {
          for (const trivia of ['', ' /* name */ ', '\n']) {
            for (const annotation of ['T', 'typeof ns.x', 'readonly T[]', 'T extends U?V:W']) {
              const sourceFor = (type: string): string =>
                context.replace('SIGNATURE', `(${name}${optional}${trivia}:${type})=>${returnType}`);
              const source = sourceFor(annotation);
              const nameStart = source.indexOf(name);
              const tree = parser.parse(source)!;
              try {
                expect(tree.rootNode.hasError).toBe(false);
                const bindings = parameterBindingIdentifiers(tree.rootNode).filter((node) => node.text === name);
                expect(bindings.map((node) => [node.startIndex, node.endIndex])).toEqual([
                  [nameStart, nameStart + name.length],
                ]);
                const parameter = bindings[0]!.parent!;
                expect(parameter.type).toBe(optional ? 'optional_parameter' : 'required_parameter');
                expect(parameter.childForFieldName('type')?.text).toBe(`:${annotation}`);
                const signature = parameter.parent!.parent!;
                expect(signature.type).toBe('function_type');
                expect(signature.childForFieldName('return_type')?.text).toBe(returnType);
              } finally {
                tree.delete();
              }
              for (const missing of ['', '/* removed */']) {
                const broken = parser.parse(sourceFor(missing))!;
                try {
                  expect(broken.rootNode.hasError).toBe(true);
                } finally {
                  broken.delete();
                }
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
