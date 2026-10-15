import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript-reference';
import typescriptGrammar from '../typescript/src/grammar.json';
import tsxGrammar from '../tsx/src/grammar.json';
import { queryOperandKeywords } from './grammarKeywordStarts';

const keywords: string[] = [];
for (let kind = ts.SyntaxKind.FirstKeyword; kind <= ts.SyntaxKind.LastKeyword; kind++) {
  const word = ts.tokenToString(kind);
  if (word !== undefined && kind !== ts.SyntaxKind.ExportKeyword) keywords.push(word);
}
assert.ok(keywords.length > 0);
const grammarArgument = process.argv.indexOf('--grammar');
const queryKeywords =
  grammarArgument === -1
    ? queryOperandKeywords(typescriptGrammar)
    : queryOperandKeywords(JSON.parse(readFileSync(process.argv[grammarArgument + 1]!, 'utf8')));
if (grammarArgument === -1) assert.deepEqual(queryKeywords, queryOperandKeywords(tsxGrammar));
const header = `// Generated from TypeScript ${ts.version} and grammar token starts by scripts/generateGlobalKeywords.ts.
#pragma once

#define TS_GLOBAL_KEYWORD_MAX_LENGTH ${Math.max(...keywords.map((word) => word.length))}

static const char *const TS_GLOBAL_KEYWORDS[] = {
${keywords.map((word) => `    "${word}",`).join('\n')}
};

static const char *const TS_NON_IDENTIFIER_QUERY_KEYWORDS[] = {
${queryKeywords.map((word) => `    "${word}",`).join('\n')}
};
`;
const path = new URL('../common/typeScriptKeywords.h', import.meta.url);
if (process.argv.includes('--check')) {
  assert.equal(readFileSync(path, 'utf8'), header, 'Run bun run generate-keywords to update the scanner header.');
} else {
  writeFileSync(path, header);
}
