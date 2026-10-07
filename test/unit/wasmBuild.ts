import fs from 'node:fs';
import path from 'node:path';

import { generationInputMtime } from '../helpers/generationInputs.js';

import { Language } from '@willbooster/web-tree-sitter';

const Root = path.join(import.meta.dirname, '../..');

// Call `Parser.init()` before loading the package’s Wasm build. Source freshness is checked because tests load the existing build.
export async function loadCurrentWasmBuild(grammar: string): Promise<Language> {
  const wasmPath = path.join(Root, `tree-sitter-${grammar}.wasm`);
  const sources = [
    'common/defineGrammar.js',
    'common/scanner.h',
    `${grammar}/grammar.js`,
    `${grammar}/src/parser.c`,
    `${grammar}/src/scanner.c`,
  ].map((name) => fs.statSync(path.join(Root, name)).mtimeMs);
  if (Math.max(generationInputMtime(Root), ...sources) > fs.statSync(wasmPath).mtimeMs) {
    throw new Error(
      `generation inputs or ${grammar}/src/ changed after the Wasm build was built; run \`bun run build/ci\``
    );
  }
  return Language.load(wasmPath);
}
