# @willbooster/tree-sitter-typescript

[![npm version](https://img.shields.io/npm/v/@willbooster/tree-sitter-typescript.svg)](https://www.npmjs.com/package/@willbooster/tree-sitter-typescript)
[![license](https://img.shields.io/npm/l/@willbooster/tree-sitter-typescript.svg)](https://www.npmjs.com/package/@willbooster/tree-sitter-typescript)
[![Test](https://github.com/WillBooster/tree-sitter-typescript/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/tree-sitter-typescript/actions/workflows/test.yml)
[![Test rust](https://github.com/WillBooster/tree-sitter-typescript/actions/workflows/test-rust.yml/badge.svg)](https://github.com/WillBooster/tree-sitter-typescript/actions/workflows/test-rust.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![wbfy](https://img.shields.io/badge/wbfy-20.26.0-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)
[![crates.io](https://img.shields.io/crates/v/willbooster-tree-sitter-typescript.svg)](https://crates.io/crates/willbooster-tree-sitter-typescript)

TypeScript and TSX grammars for [tree-sitter](https://github.com/tree-sitter/tree-sitter), forked from
[tree-sitter/tree-sitter-typescript](https://github.com/tree-sitter/tree-sitter-typescript). We are grateful
to its authors and contributors. This is not an official release of that project.

This fork fixes parsing bugs and raises conformance with [TypeScript](https://www.typescriptlang.org/docs/handbook/intro.html)
and, for TSX, [JSX](https://facebook.github.io/jsx/).

TypeScript and TSX are two different dialects (`<T>x` is a type assertion in TypeScript but a JSX element in TSX),
so this package defines two grammars: `typescript` in `typescript/` and `tsx` in `tsx/`, both generated from
`common/defineGrammar.js`. The `tsx` grammar also parses JavaScript with [Flow](https://flow.org/) type annotations.

## Usage

The npm package ships `tree-sitter-typescript.wasm` and `tree-sitter-tsx.wasm` for
[web-tree-sitter](https://www.npmjs.com/package/web-tree-sitter):

```js
import { fileURLToPath } from 'node:url';
import { Language, Parser } from 'web-tree-sitter';

await Parser.init();
const parser = new Parser();
const wasmPath = fileURLToPath(import.meta.resolve('@willbooster/tree-sitter-typescript/tree-sitter-typescript.wasm'));
parser.setLanguage(await Language.load(wasmPath));
const tree = parser.parse('const x: number = 1;\n');
```

The package also ships the node types in `typescript/src/node-types.json` and `tsx/src/node-types.json`.

In Rust, depend on the [crate](https://crates.io/crates/willbooster-tree-sitter-typescript):

```toml
[dependencies]
tree-sitter = "0.27"
tree-sitter-typescript = { package = "willbooster-tree-sitter-typescript", version = "1" }
```

```rust
let mut parser = tree_sitter::Parser::new();
parser.set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into())?;
// or `tree_sitter_typescript::LANGUAGE_TSX` for TSX
```

## Development

```sh
mise install
bun install --frozen-lockfile
bun run build/ci
bun run test
script/parse-examples
cargo test
```

`bun run build/ci` regenerates `typescript/src/` and `tsx/src/` and builds both Wasm files. `bun run test` runs:

- the corpus in `test/corpus`, with the native build and with the Wasm build (the first run downloads the WASI SDK).
  Cases run with the `typescript` grammar unless they carry `:language(tsx)`;
- an incremental-parsing check (`test/unit/incremental.test.ts`): `tree-sitter fuzz` edits each corpus case of the
  `typescript` grammar at random, reparses it, undoes the edits, and reparses again. `TREE_SITTER_SEED`,
  `TREE_SITTER_ITERATIONS`, and `TREE_SITTER_EDITS` run other or more edits;
- a check that the real-world files in `examples/`, the checked-in ones and those of the cloned repositories, fail to
  parse exactly as listed in `script/known-failures.txt`. `.ts` files are parsed with the `typescript` grammar and
  `.tsx` files with the `tsx` grammar. The first run clones the repositories. The example repositories are pinned to
  commits in `script/parse-examples`. After a grammar change or a moved pin alters that list, `script/parse-examples`
  rewrites it; review its diff before committing;
- a performance check (`test/unit/performance.test.ts`) that recovering from an error on each of 10,000 lines takes
  linear time with each grammar, since consumers parse files while they are being edited. It loads the Wasm builds
  through web-tree-sitter, which `bun run build/ci` rebuilds after regenerating the parsers.

CI also runs these tests on Linux arm64 and macOS, where the Rust binding compiles the parsers natively, and fuzzes
both parsers with libFuzzer and sanitizers (`.github/workflows/robustness.yml`).

### References

- [TypeScript Language Spec](https://github.com/microsoft/TypeScript/blob/30cb20434a6b117e007a4959b2a7c16489f86069/doc/spec-ARCHIVED.md)
