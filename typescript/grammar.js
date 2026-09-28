// oxlint-disable unicorn/prefer-module -- This package is CommonJS, so tree-sitter loads grammar.js as CommonJS.
const defineGrammar = require('../common/defineGrammar');

module.exports = defineGrammar('typescript');
