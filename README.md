# @willbooster/tree-sitter-typescript

This is a fork of [tree-sitter/tree-sitter-typescript](https://github.com/tree-sitter/tree-sitter-typescript). We are grateful to its authors and
contributors. This is not an official release of that project.

TypeScript and TSX grammars for [tree-sitter][].

Because TSX and TypeScript are actually two different dialects, this module defines two grammars. Require them as follows:

```js
require("tree-sitter-typescript").typescript; // TypeScript grammar
require("tree-sitter-typescript").tsx; // TSX grammar
```

For Javascript files with [flow] type annotations you can use the `tsx` parser.

[tree-sitter]: https://github.com/tree-sitter/tree-sitter
[flow]: https://flow.org/en/

References

- [TypeScript Language Spec](https://github.com/microsoft/TypeScript/blob/30cb20434a6b117e007a4959b2a7c16489f86069/doc/spec-ARCHIVED.md)
