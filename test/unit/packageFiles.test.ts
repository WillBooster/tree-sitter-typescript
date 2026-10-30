import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { test } from 'vitest';

const Root = path.join(import.meta.dirname, '../..');

test('keeps the inherited grammar source synchronized with the JavaScript package', () => {
  execFileSync(path.join(Root, 'script', 'copy-javascript-grammar'), ['--check'], { cwd: Root });
});
