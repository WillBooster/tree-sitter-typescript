import fs from 'node:fs';
import path from 'node:path';

import { Language } from '@willbooster/web-tree-sitter';

const Root = path.join(import.meta.dirname, '../..');

// Loads the Wasm build that the package ships. Only `bun run build/ci` rebuilds it, so a test against a stale one would
// pass after a source edit; this fails instead. Call `Parser.init()` first.
export async function loadCurrentWasmBuild(grammar: string): Promise<Language> {
  const wasmPath = path.join(Root, `tree-sitter-${grammar}.wasm`);
  // src/parser.c is generated from the grammar, so an edit to the grammar alone also makes the Wasm build stale.
  const sources = [
    'common/defineGrammar.js',
    'common/scanner.h',
    `${grammar}/grammar.js`,
    `${grammar}/src/parser.c`,
    `${grammar}/src/scanner.c`,
  ].map((name) => fs.statSync(path.join(Root, name)).mtimeMs);
  if (Math.max(...sources) > fs.statSync(wasmPath).mtimeMs) {
    throw new Error(`common/ or ${grammar}/ changed after the Wasm build was built; run \`bun run build/ci\``);
  }
  return Language.load(wasmPath);
}
