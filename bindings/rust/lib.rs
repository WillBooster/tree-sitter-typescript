//! This crate provides TypeScript and TSX language support for the [tree-sitter] parsing library.
//!
//! Typically, you will use the [`LANGUAGE_TYPESCRIPT`] or [`LANGUAGE_TSX`] constant to add a language
//! to a tree-sitter [`Parser`], and then use the parser to parse some code:
//!
//! ```
//! let code = "function double(x: number): number {\n    return x * 2;\n}\n";
//! let mut parser = tree_sitter::Parser::new();
//! let language = tree_sitter_typescript::LANGUAGE_TYPESCRIPT;
//! parser
//!     .set_language(&language.into())
//!     .expect("Error loading TypeScript parser");
//! let tree = parser.parse(code, None).unwrap();
//! assert!(!tree.root_node().has_error());
//! ```
//!
//! [`Parser`]: https://docs.rs/willbooster-tree-sitter/1.0.0/tree_sitter/struct.Parser.html
//! [tree-sitter]: https://tree-sitter.github.io/

use tree_sitter_language::LanguageFn;

unsafe extern "C" {
    fn tree_sitter_typescript() -> *const ();
    fn tree_sitter_tsx() -> *const ();
}

/// The tree-sitter [`LanguageFn`] for TypeScript.
pub const LANGUAGE_TYPESCRIPT: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_typescript) };

/// The tree-sitter [`LanguageFn`] for TSX.
pub const LANGUAGE_TSX: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_tsx) };

/// The content of the [`node-types.json`] file for TypeScript.
///
/// [`node-types.json`]: https://tree-sitter.github.io/tree-sitter/using-parsers/6-static-node-types
pub const TYPESCRIPT_NODE_TYPES: &str = include_str!("../../typescript/src/node-types.json");

/// The content of the [`node-types.json`] file for TSX.
///
/// [`node-types.json`]: https://tree-sitter.github.io/tree-sitter/using-parsers/6-static-node-types
pub const TSX_NODE_TYPES: &str = include_str!("../../tsx/src/node-types.json");

#[cfg(test)]
mod tests {
    #[test]
    fn test_can_load_typescript_grammar() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::LANGUAGE_TYPESCRIPT.into())
            .expect("Error loading TypeScript parser");
    }

    #[test]
    fn test_can_load_tsx_grammar() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::LANGUAGE_TSX.into())
            .expect("Error loading TSX parser");
    }
}
