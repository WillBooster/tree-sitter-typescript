import { execFileSync } from 'node:child_process';
import path from 'node:path';

// script/tree-sitter fetches the CLI on its first run, which takes over 10 minutes when it falls back to building it.
// Fetching it once before the test files run in parallel keeps each of them from building it within its own timeout.
export default function setup(): void {
  execFileSync(path.resolve(import.meta.dirname, '../../script/tree-sitter'), ['--version'], { stdio: 'inherit' });
}
