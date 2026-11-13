import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');

for (const dialect of ['typescript', 'tsx']) {
  test(`generates ${dialect} keywords without the other dialect's generated grammar`, () => {
    // Cargo can inspect ignored directories when package.include is set; fixture cleanup must stay outside its walk.
    const fixture = fs.mkdtempSync('/tmp/typescript-keyword-generation-');
    try {
      for (const file of [
        'scripts/generateGlobalKeywords.ts',
        'scripts/grammarKeywordStarts.ts',
        `${dialect}/src/grammar.json`,
      ]) {
        const target = path.join(fixture, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(root, file), target);
      }
      fs.mkdirSync(path.join(fixture, 'common'));
      fs.symlinkSync(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'junction');
      execFileSync('bun', ['scripts/generateGlobalKeywords.ts', '--grammar', `${dialect}/src/grammar.json`], {
        cwd: fixture,
        encoding: 'utf8',
      });
      expect(fs.readFileSync(path.join(fixture, 'common/typeScriptKeywords.h'), 'utf8')).toBe(
        fs.readFileSync(path.join(root, 'common/typeScriptKeywords.h'), 'utf8')
      );
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
}

test('check-keywords rejects unsorted or overlong TSKeyword tables in common/scanner.h', () => {
  const fixture = fs.mkdtempSync('/tmp/typescript-keyword-check-');
  try {
    for (const file of [
      'scripts/generateGlobalKeywords.ts',
      'scripts/grammarKeywordStarts.ts',
      'common/typeScriptKeywords.h',
      'typescript/src/grammar.json',
      'tsx/src/grammar.json',
    ]) {
      const target = path.join(fixture, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, file), target);
    }
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'junction');
    const scannerSource = fs.readFileSync(path.join(root, 'common/scanner.h'), 'utf8');
    for (const invalidScanner of [
      scannerSource.replace('"while",    "with",', '"with",     "while",'),
      scannerSource.replace('"satisfies",', '"instanceof22",'),
    ]) {
      fs.writeFileSync(path.join(fixture, 'common/scanner.h'), invalidScanner);
      expect(() =>
        execFileSync('bun', ['scripts/generateGlobalKeywords.ts', '--check'], {
          cwd: fixture,
          encoding: 'utf8',
          stdio: 'pipe',
        })
      ).toThrow();
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
