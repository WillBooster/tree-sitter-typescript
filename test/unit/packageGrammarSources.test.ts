import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

const Root = path.resolve(import.meta.dirname, '../..');

interface ExecOptions {
  cwd: string;
  encoding: 'utf8';
  timeout: number;
}

test.each(['npm', 'crate'] as const)(
  'generates both published grammars from the %s package in an isolated consumer',
  (packageKind) => {
    // Keep the consumer outside the repository so Node cannot resolve missing dependencies from this checkout.
    const consumer = fs.mkdtempSync('/tmp/tree-sitter-typescript-consumer-');
    const options = { cwd: consumer, encoding: 'utf8', timeout: 240_000 } as const;
    try {
      const grammarRoot = packageKind === 'npm' ? installNpmPackage(consumer, options) : unpackCrate(consumer, options);
      for (const dialect of ['typescript', 'tsx']) {
        const output = path.join(consumer, 'generated', dialect);
        execFileSync(
          path.join(Root, 'script/tree-sitter'),
          ['generate', '--no-parser', '--output', output, path.join(grammarRoot, dialect, 'grammar.js')],
          options
        );
        const nodeTypes = JSON.parse(fs.readFileSync(path.join(output, 'node-types.json'), 'utf8'));
        expect(nodeTypes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: 'class_declaration', named: true }),
            expect.objectContaining({ type: 'type_annotation', named: true }),
          ])
        );
      }
    } finally {
      fs.rmSync(consumer, { recursive: true, force: true });
    }
  },
  300_000
);

function installNpmPackage(consumer: string, options: ExecOptions): string {
  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', consumer], { ...options, cwd: Root });
  const archives = fs.readdirSync(consumer).filter((name) => name.endsWith('.tgz'));
  expect(archives).toHaveLength(1);
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    JSON.stringify({
      private: true,
      dependencies: { '@willbooster/tree-sitter-typescript': path.join(consumer, archives[0]!) },
    })
  );
  execFileSync('bun', ['install', '--production', '--ignore-scripts'], options);
  return path.join(consumer, 'node_modules/@willbooster/tree-sitter-typescript');
}

function unpackCrate(consumer: string, options: ExecOptions): string {
  const target = path.join(consumer, 'target');
  execFileSync('cargo', ['package', '--allow-dirty', '--no-verify', '--target-dir', target], { ...options, cwd: Root });
  const archives = fs.readdirSync(path.join(target, 'package')).filter((name) => name.endsWith('.crate'));
  expect(archives).toHaveLength(1);
  execFileSync('tar', ['-xzf', path.join(target, 'package', archives[0]!), '-C', consumer], options);
  return path.join(consumer, path.basename(archives[0]!, '.crate'));
}
