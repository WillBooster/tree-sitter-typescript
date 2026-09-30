/// <reference types="vite/client" />
import { Language, Parser } from '@willbooster/web-tree-sitter';
import runtimeUrl from '@willbooster/web-tree-sitter/web-tree-sitter.wasm?url';
import { expect, test } from 'vitest';

import tsxUrl from '../../../tree-sitter-tsx.wasm?url';
import typescriptUrl from '../../../tree-sitter-typescript.wasm?url';
import { expectedTrees } from '../../fixtures/expectedTrees.js';

const urls = { typescript: typescriptUrl, tsx: tsxUrl };

test.each(Object.entries(expectedTrees))(
  'parses with the %s grammar in a browser',
  async (grammar, { source, tree }) => {
    await Parser.init({ locateFile: () => runtimeUrl });
    const parser = new Parser();
    parser.setLanguage(await Language.load(urls[grammar as keyof typeof urls]));
    expect(parser.parse(source)?.rootNode.toString()).toBe(tree);
  }
);
