import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Language, Parser, Query } from '@willbooster/web-tree-sitter';

const root = path.join(import.meta.dirname, '..');
const dependency = path.join(root, 'node_modules/@willbooster/tree-sitter-javascript');
const check = process.argv.includes('--check');

await mkdir(path.join(root, 'javascript/queries'), { recursive: true });
for (const name of ['highlights.scm', 'highlights-jsx.scm', 'injections.scm', 'locals.scm', 'tags.scm']) {
  await syncFile(`javascript/queries/${name}`, await readFile(path.join(dependency, 'queries', name)));
}

await Parser.init();
const language = await Language.load(path.join(dependency, 'tree-sitter-javascript.wasm'));
const source = await readFile(path.join(dependency, 'queries/tags.scm'));
const query = new Query(language, source.toString());
try {
  const patterns = Array.from({ length: query.patternCount() }, (_, index) =>
    source.subarray(query.startIndexForPattern(index), query.endIndexForPattern(index)).toString().trim()
  );
  await syncFile(
    'queries/javascript-tags.scm',
    Buffer.from(patterns.filter((pattern) => !/\(jsx_/.test(pattern)).join('\n\n') + '\n')
  );
} finally {
  query.delete();
}

async function syncFile(relativePath: string, expected: Buffer): Promise<void> {
  const destination = path.join(root, relativePath);
  if (check) {
    const actual = await readFile(destination);
    if (!actual.equals(expected)) {
      throw new Error(`${relativePath} differs; run script/copy-javascript-queries`);
    }
  } else {
    await writeFile(destination, expected);
  }
}
