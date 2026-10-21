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
