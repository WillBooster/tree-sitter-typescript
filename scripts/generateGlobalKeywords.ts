import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript-reference';

const keywords: string[] = [];
for (let kind = ts.SyntaxKind.FirstKeyword; kind <= ts.SyntaxKind.LastKeyword; kind++) {
  const word = ts.tokenToString(kind);
  if (word !== undefined && kind !== ts.SyntaxKind.ExportKeyword) keywords.push(word);
}
assert.ok(keywords.length > 0);
const header = `// Generated from TypeScript ${ts.version} by scripts/generateGlobalKeywords.ts.
#pragma once

#define TS_GLOBAL_KEYWORD_MAX_LENGTH ${Math.max(...keywords.map((word) => word.length))}

static const char *const TS_GLOBAL_KEYWORDS[] = {
${keywords.map((word) => `    "${word}",`).join('\n')}
};
`;
const path = new URL('../common/typeScriptKeywords.h', import.meta.url);
if (process.argv.includes('--check')) {
  assert.equal(readFileSync(path, 'utf8'), header, 'Run bun run generate-keywords to update the scanner header.');
} else {
  writeFileSync(path, header);
}
