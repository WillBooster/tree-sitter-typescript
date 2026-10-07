# @willbooster/tree-sitter-typescript

[![npm version](https://img.shields.io/npm/v/@willbooster/tree-sitter-typescript.svg)](https://www.npmjs.com/package/@willbooster/tree-sitter-typescript)
[![license](https://img.shields.io/npm/l/@willbooster/tree-sitter-typescript.svg)](https://www.npmjs.com/package/@willbooster/tree-sitter-typescript)
[![Test](https://github.com/WillBooster/tree-sitter-typescript/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/tree-sitter-typescript/actions/workflows/test.yml)
[![Test rust](https://github.com/WillBooster/tree-sitter-typescript/actions/workflows/test-rust.yml/badge.svg)](https://github.com/WillBooster/tree-sitter-typescript/actions/workflows/test-rust.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![wbfy](https://img.shields.io/badge/wbfy-20.28.5-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)
[![crates.io](https://img.shields.io/crates/v/willbooster-tree-sitter-typescript.svg)](https://crates.io/crates/willbooster-tree-sitter-typescript)

TypeScript and TSX grammars for [tree-sitter](https://github.com/tree-sitter/tree-sitter), forked from
[tree-sitter/tree-sitter-typescript](https://github.com/tree-sitter/tree-sitter-typescript). We are grateful
to its authors and contributors. This is not an official release of that project.

This fork fixes parsing bugs and raises conformance with [TypeScript](https://www.typescriptlang.org/docs/handbook/intro.html)
and, for TSX, [JSX](https://facebook.github.io/jsx/).

TypeScript and TSX are two different dialects (`<T>x` is a type assertion in TypeScript but a JSX element in TSX),
so this package defines two grammars: `typescript` in `typescript/` and `tsx` in `tsx/`, both generated from
`common/defineGrammar.js`, which extends the JavaScript grammar of
[@willbooster/tree-sitter-javascript](https://www.npmjs.com/package/@willbooster/tree-sitter-javascript) and ports its
external scanner in `common/scanner.h`. The `tsx` grammar also parses JavaScript with [Flow](https://flow.org/) type
annotations.

## Usage

The npm package ships `tree-sitter-typescript.wasm` and `tree-sitter-tsx.wasm` for
[@willbooster/web-tree-sitter](https://www.npmjs.com/package/@willbooster/web-tree-sitter), which runs in Node.js,
Bun, browsers, and Cloudflare Workers. Load `tree-sitter-typescript.wasm` for `.ts` files and `tree-sitter-tsx.wasm`
for `.tsx` files. Both compact ABI 16 parsers require runtime 1.3.0 or later.

In Node.js and Bun:

```js
import { fileURLToPath } from 'node:url';
import { Language, Parser } from '@willbooster/web-tree-sitter';

await Parser.init();
const parser = new Parser();
const wasmPath = fileURLToPath(import.meta.resolve('@willbooster/tree-sitter-typescript/tree-sitter-typescript.wasm'));
parser.setLanguage(await Language.load(wasmPath));
const tree = parser.parse('const x: number = 1;\n');
```

In browsers, load the `.wasm` files by URL. With Vite:

```js
import { Language, Parser } from '@willbooster/web-tree-sitter';
import runtimeUrl from '@willbooster/web-tree-sitter/web-tree-sitter.wasm?url';
import tsxUrl from '@willbooster/tree-sitter-typescript/tree-sitter-tsx.wasm?url';

await Parser.init({ locateFile: () => runtimeUrl });
const parser = new Parser();
parser.setLanguage(await Language.load(tsxUrl));
```

In Cloudflare Workers, which do not allow compiling Wasm at run time, import the `.wasm` files as modules (with or
without Node.js compatibility):

```js
import { Language, Parser } from '@willbooster/web-tree-sitter';
import runtime from '@willbooster/web-tree-sitter/web-tree-sitter.wasm';
import typescript from '@willbooster/tree-sitter-typescript/tree-sitter-typescript.wasm';

await Parser.init({ wasmModule: runtime });
const parser = new Parser();
parser.setLanguage(await Language.load(typescript));
```

The package also ships the node types in `typescript/src/node-types.json` and `tsx/src/node-types.json`, and the
highlighting, injection, locals, and tags queries that `tree-sitter.json` lists: this grammar's in `queries/` and, in
`javascript/queries/`, those of the JavaScript grammar it extends.

In Rust, depend on the [crate](https://crates.io/crates/willbooster-tree-sitter-typescript) and on
[willbooster-tree-sitter](https://crates.io/crates/willbooster-tree-sitter), the runtime this package is tested and
fuzzed with. The compact ABI 16 parser requires runtime 1.3.0 or later:

```toml
[dependencies]
tree-sitter = { package = "willbooster-tree-sitter", version = "1.3.0" }
tree-sitter-typescript = { package = "willbooster-tree-sitter-typescript", version = "4" }
```

```rust
let mut parser = tree_sitter::Parser::new();
parser.set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into())?;
// or `tree_sitter_typescript::LANGUAGE_TSX` for TSX
```

The crate ships the same `tree-sitter.json` and query files as the npm package.

## Development

```sh
mise install
bun install --frozen-lockfile
bun run test/ci-setup
bun run build/ci
bun run test
script/parse-examples
cargo test
```

`script/tree-sitter` (also `bun run tree-sitter`) runs the tree-sitter CLI of WillBooster/tree-sitter at the runtime
version locked in `Cargo.lock`, so the parsers are generated, built, tested, and fuzzed with the generator and the
runtime this package ships. The first run downloads that CLI from its GitHub Release into `.tmp/`, or builds it with
`cargo` (with the `cmake` that `mise.toml` pins) when the download fails or the release has no binary that runs here.

`bun run test/ci-setup` installs Chromium for the browser tests. `bun run build/ci` regenerates `typescript/src/` and
`tsx/src/` and builds both Wasm files. It also refreshes `common/typeScriptKeywords.h` from the pinned
`typescript-reference` API (TypeScript 5.9.3), which supplies the global-augmentation lookahead vocabulary.
The native TypeScript package remains the type checker. Run `bun run generate-keywords` after changing the reference;
verification checks the committed header with `bun run check-keywords`.

`bun run generate` records a fresh ABI 16 generation profile from the applicable `test/corpus` cases and Git-tracked
files in `examples/`, then generates compact parser tables. The parser also embeds metadata from `tree-sitter.json`. After changing a grammar,
`tree-sitter.json`, a corpus case, or a tracked example,
regenerate and commit `typescript/src/` and `tsx/src/`. Stage added or removed examples with `git add -A examples` before generation so the profile uses the intended file list.
Profiles in `.tmp/generation-profiles/` are temporary and must not be committed. `bun run build-wasm`, `bun run build/ci`,
and the release build regenerate the parsers before compiling them.

`bun run test` runs:

- the corpus in `test/corpus`, with the native build and with the Wasm build (the first run downloads the WASI SDK).
  Cases run with the `typescript` grammar unless they carry `:language(tsx)`;
- an incremental-parsing check (`test/unit/incremental.test.ts`): `script/fuzz-corpus` runs `tree-sitter fuzz`, which
  edits each corpus case of each grammar at random, reparses it, undoes the edits, and reparses again.
  `TREE_SITTER_SEED`, `TREE_SITTER_ITERATIONS`, and `TREE_SITTER_EDITS` run other or more edits;
- a check that the real-world files in `examples/`, the checked-in ones and those of the cloned repositories, fail to
  parse exactly as listed in `script/known-failures.txt`. `.ts` files are parsed with the `typescript` grammar and
  `.tsx` files with the `tsx` grammar. The first run clones the repositories. The example repositories are pinned to
  commits in `script/parse-examples`. After a grammar change or a moved pin alters that list, `script/parse-examples`
  rewrites it; review its diff before committing;
- a performance check (`test/unit/performance.test.ts`) that recovering from an error on each of 20,000 lines takes
  linear time with each grammar, measured in the parsing thread's CPU time, since consumers parse files while they are
  being edited. It loads the Wasm builds through @willbooster/web-tree-sitter, which `bun run build/ci` rebuilds after
  regenerating the parsers;
- a check (`test/unit/queries.test.ts`) that the queries `tree-sitter.json` lists compile against each grammar, are
  published in the npm package and the crate, and that `javascript/queries/` matches the queries of the installed
  @willbooster/tree-sitter-javascript. After updating that dependency, run `script/copy-javascript-queries` to refresh
  the copies and the derived `queries/javascript-tags.scm`. TypeScript uses that JSX-free tags file; TSX and Flow
  use the complete JavaScript tags;
- checks that both Wasm builds load and parse through @willbooster/web-tree-sitter in Chromium
  (`test/unit/browser/`) and in Cloudflare Workers with and without Node.js compatibility
  (`test/unit/workers.test.ts`, running the Worker in `test/fixtures/worker/`);
- a check (`test/unit/runtimeVersion.test.ts`) that `package.json` and `Cargo.lock` lock the same runtime version,
  since the Wasm tests run on @willbooster/web-tree-sitter and the Rust tests, the fuzzing, and the CLI on the
  willbooster-tree-sitter crate.

The tests compile the parsers into `.tmp/tree-sitter-lib` instead of the CLI's cache shared by every checkout;
`script/parse-examples` and `script/fuzz-corpus` build a parser of their own per run and delete it afterwards.
`mise.toml` sets `TREE_SITTER_LIBDIR` to `.tmp/tree-sitter-lib` as well, so other `tree-sitter` commands run in the
checkout use this checkout's parsers too.

CI also runs these tests on Linux arm64 and macOS, where the Rust binding compiles the parsers natively, and fuzzes
both parsers with libFuzzer and sanitizers (`.github/workflows/robustness.yml`).

### References

- [TypeScript Language Spec](https://github.com/microsoft/TypeScript/blob/30cb20434a6b117e007a4959b2a7c16489f86069/doc/spec-ARCHIVED.md)
