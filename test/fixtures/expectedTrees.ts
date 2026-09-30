// `<T>x` is a type assertion in TypeScript but a JSX element in TSX, so each grammar has to be the one loaded.
export const expectedTrees = {
  typescript: {
    source: 'let x = <T>y;',
    tree: '(program (lexical_declaration (variable_declarator name: (identifier) value: (type_assertion (type_arguments (type_identifier)) (identifier)))))',
  },
  tsx: {
    source: 'let x = <T>y</T>;',
    tree: '(program (lexical_declaration (variable_declarator name: (identifier) value: (jsx_element open_tag: (jsx_opening_element name: (identifier)) (jsx_text) close_tag: (jsx_closing_element name: (identifier))))))',
  },
};
