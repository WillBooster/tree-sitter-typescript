import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import ts from 'typescript-reference';

import { grammarOperandKeywords } from './grammarKeywordStarts';

const keywords: string[] = [];
const bindingKeywords: string[] = [];
for (let kind = ts.SyntaxKind.FirstKeyword; kind <= ts.SyntaxKind.LastKeyword; kind++) {
  const word = ts.tokenToString(kind);
  if (word !== undefined && kind !== ts.SyntaxKind.ExportKeyword) keywords.push(word);
}
for (let kind = ts.SyntaxKind.FirstReservedWord; kind <= ts.SyntaxKind.LastReservedWord; kind++) {
  const word = ts.tokenToString(kind);
  if (word !== undefined) bindingKeywords.push(word);
}
assert.ok(keywords.length > 0);
const grammarArgument = process.argv.indexOf('--grammar');
const operandKeywords =
  grammarArgument === -1
    ? grammarOperandKeywords(
        JSON.parse(readFileSync(new URL('../typescript/src/grammar.json', import.meta.url), 'utf8'))
      )
    : grammarOperandKeywords(JSON.parse(readFileSync(process.argv[grammarArgument + 1]!, 'utf8')));
if (grammarArgument === -1)
  assert.deepEqual(
    operandKeywords,
    grammarOperandKeywords(JSON.parse(readFileSync(new URL('../tsx/src/grammar.json', import.meta.url), 'utf8')))
  );
const header = `// Generated from TypeScript ${ts.version} and grammar token starts by scripts/generateGlobalKeywords.ts.
#pragma once

#define TS_GLOBAL_KEYWORD_MAX_LENGTH ${Math.max(...keywords.map((word) => word.length))}

static const char *const TS_GLOBAL_KEYWORDS[] = {
${keywords.map((word) => `    "${word}",`).join('\n')}
};

static const char *const TS_BINDING_RESERVED_KEYWORDS[] = {
${bindingKeywords.map((word) => `    "${word}",`).join('\n')}
};

static const char *const TS_NON_IDENTIFIER_QUERY_KEYWORDS[] = {
${operandKeywords.query.map((word) => `    "${word}",`).join('\n')}
};

static const char *const TS_EXPRESSION_ONLY_TYPE_KEYWORDS[] = {
${operandKeywords.expressionOnly.map((word) => `    "${word}",`).join('\n')}
};

static const char *const TS_EXPRESSION_PREFIX_KEYWORDS[] = {
${operandKeywords.expressionPrefix.map((word) => `    "${word}",`).join('\n')}
};

static const char *const TS_NON_PARAMETER_PATTERN_KEYWORDS[] = {
${operandKeywords.nonParameterPattern.map((word) => `    "${word}",`).join('\n')}
};

static const char *const TS_TYPE_ONLY_ATOM_KEYWORDS[] = {
${operandKeywords.typeOnlyAtom.map((word) => `    "${word}",`).join('\n')}
};

static const char *const TS_PARAMETER_HEADER_KEYWORDS[] = {
${operandKeywords.parameterHeader.map((word) => `    "${word}",`).join('\n')}
};

static const char *const TS_ASSERTION_PREDICATE_SUBJECT_KEYWORDS[] = {
${operandKeywords.assertionPredicate.map((word) => `    "${word}",`).join('\n')}
};

static const char *const TS_NON_ASSERTION_IDENTIFIER_KEYWORDS[] = {
${operandKeywords.assertion.map((word) => `    "${word}",`).join('\n')}
};
`;
const path = new URL('../common/typeScriptKeywords.h', import.meta.url);
if (process.argv.includes('--check')) {
  assert.equal(readFileSync(path, 'utf8'), header, 'Run bun run generate-keywords to update the scanner header.');
} else if (!existsSync(path) || readFileSync(path, 'utf8') !== header) {
  writeFileSync(path, header);
}
