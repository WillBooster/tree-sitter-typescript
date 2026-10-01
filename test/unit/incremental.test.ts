import { expect } from 'vitest';

import { testCommand } from './run.js';

// Edits each corpus case at random and reparses it incrementally, then undoes the edits and reparses
// again: the changed ranges must cover every change and the final tree must match the corpus. The CLI
// exits zero even when a case fails or no corpus is found, so its output decides: it must list the cases
// it fuzzed and print no failure summary. TREE_SITTER_SEED, TREE_SITTER_ITERATIONS,
// and TREE_SITTER_EDITS explore further locally. The first test downloads the CLI. The timeout leaves room for building
// it instead when its release has no binary that runs on the platform, which would take over 10 minutes on GitHub's
// Intel macOS runner.
for (const grammar of ['typescript', 'tsx']) {
  testCommand(
    `reparses the ${grammar} corpus consistently after random edits`,
    ['script/fuzz-corpus', grammar],
    1_800_000,
    {
      env: {
        TREE_SITTER_SEED: process.env.TREE_SITTER_SEED ?? '1',
        TREE_SITTER_ITERATIONS: process.env.TREE_SITTER_ITERATIONS ?? '1000',
        TREE_SITTER_EDITS: process.env.TREE_SITTER_EDITS ?? '10',
      },
      check: (output) => {
        expect(output).toMatch(new RegExp(String.raw`^ +\d+\. ${grammar} - corpus - `, 'm'));
        expect(output).not.toContain('failed fuzzing');
      },
    }
  );
}
