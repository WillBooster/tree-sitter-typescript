#include "tree_sitter/alloc.h"
#include "tree_sitter/parser.h"

#include <string.h>

enum TokenType {
    AUTOMATIC_SEMICOLON,
    TEMPLATE_CHARS,
    TERNARY_QMARK,
    HTML_COMMENT,
    LOGICAL_OR,
    ESCAPE_SEQUENCE,
    REGEX_PATTERN,
    JSX_TEXT,
    ARROW_FUNCTION_BLOCK_END,
    ARROW_FUNCTION_BLOCK_CONTINUATION,
    LINE_BREAK_ENDS_STATEMENT,
    LINE_BREAK_AFTER_BINDING,
    LINE_BREAK_AFTER_FIELD,
    LINE_BREAK_AFTER_MODIFIER,
    LINE_BREAK_BEFORE_ATTRIBUTES,
    FUNCTION_SIGNATURE_AUTOMATIC_SEMICOLON,
    TYPE_ARGUMENTS_END,
    TYPE_ARGUMENTS_END_AT_LINE_BREAK,
    NEW_TYPE_ARGUMENTS_END,
    ERROR_RECOVERY,
};

typedef struct {
    // Set by ARROW_FUNCTION_BLOCK_END, and cleared by the AUTOMATIC_SEMICOLON or ARROW_FUNCTION_BLOCK_CONTINUATION that
    // follows it. The flag lives in the scanner state, which tree-sitter stores in each external token, because
    // incremental parsing can reuse the arrow function and lex the next token after the parser has left the states in
    // which these tokens are valid.
    bool automatic_semicolon_pending;
} Scanner;

static inline void *external_scanner_create() { return ts_calloc(1, sizeof(Scanner)); }

static inline void external_scanner_destroy(void *payload) { ts_free(payload); }

static inline unsigned external_scanner_serialize(void *payload, char *buffer) {
    Scanner *scanner = (Scanner *)payload;
    buffer[0] = (char)scanner->automatic_semicolon_pending;
    return 1;
}

static inline void external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
    Scanner *scanner = (Scanner *)payload;
    scanner->automatic_semicolon_pending = length > 0 && buffer[0];
}

static void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

static void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

static bool scan_template_chars(TSLexer *lexer) {
    lexer->result_symbol = TEMPLATE_CHARS;
    for (bool has_content = false;; has_content = true) {
        lexer->mark_end(lexer);
        if (lexer->eof(lexer)) {
            return false;
        }
        switch (lexer->lookahead) {
            case '`':
                return has_content;
            case '$':
                advance(lexer);
                if (lexer->lookahead == '{') {
                    return has_content;
                }
                break;
            case '\\':
                return has_content;
            default:
                advance(lexer);
        }
    }
}

static inline bool is_line_terminator(int32_t c) { return c == '\n' || c == '\r' || c == 0x2028 || c == 0x2029; }

// The characters the grammar's extras skip as whitespace (see `extras_character_set_1` in the generated parser), which
// iswspace reports differently depending on the C library and locale.
static inline bool is_whitespace(int32_t c) {
    return (c >= '\t' && c <= '\r') || c == ' ' || c == 0xA0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200B) ||
           c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x2060 || c == 0x3000 || c == 0xFEFF;
}

static inline bool is_ascii_letter(int32_t c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }

static inline bool is_ascii_digit(int32_t c) { return c >= '0' && c <= '9'; }

// Counts the characters the grammar's identifiers may continue with (a backslash starts a `\u` escape), with every
// character from U+007F on other than whitespace, which suffices to tell `in` and `instanceof` from the identifiers they
// start.
static inline bool is_identifier_part(int32_t c) {
    return is_ascii_letter(c) || is_ascii_digit(c) || c == '_' || c == '$' || c == '\\' ||
           (c >= 0x7F && !is_whitespace(c));
}

// Consumes the lookahead while it matches `word`, and returns whether the whole word matched and ends there.
static bool scan_word(TSLexer *lexer, const char *word) {
    for (; *word; word++) {
        if (lexer->lookahead != *word) {
            return false;
        }
        skip(lexer);
    }
    return !is_identifier_part(lexer->lookahead);
}

typedef enum {
    NO_COMMENT,
    COMMENT,
    COMMENT_WITH_LINE_TERMINATOR,
} CommentResult;

// Skips the comment that the `/` at the lookahead starts, if any. A line comment ends before its line terminator, which
// the caller then sees; a block comment reports whether it contains one, since it then separates lines as well.
static CommentResult skip_comment(TSLexer *lexer, bool *scanned_comment) {
    skip(lexer);
    if (lexer->lookahead == '/') {
        while (!lexer->eof(lexer) && !is_line_terminator(lexer->lookahead)) {
            skip(lexer);
        }
        *scanned_comment = true;
        return COMMENT;
    }
    if (lexer->lookahead != '*') {
        return NO_COMMENT;
    }
    skip(lexer);
    bool saw_line_terminator = false;
    while (!lexer->eof(lexer)) {
        if (lexer->lookahead == '*') {
            skip(lexer);
            if (lexer->lookahead == '/') {
                skip(lexer);
                break;
            }
        } else {
            saw_line_terminator |= is_line_terminator(lexer->lookahead);
            skip(lexer);
        }
    }
    *scanned_comment = true;
    return saw_line_terminator ? COMMENT_WITH_LINE_TERMINATOR : COMMENT;
}

// Returns false at a `/` that starts no comment.
static bool scan_whitespace_and_comments(TSLexer *lexer, bool *scanned_comment) {
    for (;;) {
        while (is_whitespace(lexer->lookahead)) {
            skip(lexer);
        }
        if (lexer->lookahead != '/') {
            return true;
        }
        if (skip_comment(lexer, scanned_comment) == NO_COMMENT) {
            return false;
        }
    }
}

// Called after an arrow function's block body and a line break: such a function cannot be continued by a member
// access, call, or operator, so the statement ends unless a `,` continues the list, a `;` ends it explicitly, or a `?`
// continues an enclosing conditional expression (`a ? b : () => {}` then `? c : d`, which V8 accepts).
static bool ends_statement_after_block_arrow(TSLexer *lexer, bool *scanned_comment) {
    // A `/` that starts no comment starts a regex.
    if (!scan_whitespace_and_comments(lexer, scanned_comment)) {
        return true;
    }
    return lexer->lookahead != ',' && lexer->lookahead != ';' && lexer->lookahead != '?';
}

// What a line break after the preceding token means, told by the sentinel external tokens that the grammar allows
// only at these positions; the scanner never emits them.
typedef enum {
    // Decided by the characters that follow.
    LINE_BREAK_BY_NEXT_TOKEN,
    // After `return`, `yield`, `break`, `continue`, or `debugger`, which nothing on the next line can continue.
    LINE_BREAK_ENDS,
    // After a declared name without an initializer: only `=`, `,`, or a type annotation continues the declaration.
    LINE_BREAK_AFTER_BINDING_NAME,
    // After a class field name without an initializer: only what may follow a member's name continues it.
    LINE_BREAK_AFTER_FIELD_NAME,
    // After `static` at the start of a class member: a line break continues the member unless a `}`, an `@`, or the end
    // of input follows, which leaves a field named `static`.
    LINE_BREAK_AFTER_MODIFIER_WORD,
    // After `get` or `set` at the start of a class member: as after `static`, except that a `*` also ends the field,
    // since an accessor cannot be a generator.
    LINE_BREAK_AFTER_ACCESSOR_WORD,
    // After the source of an import or re-export: only the `with` of its attributes continues it.
    LINE_BREAK_BEFORE_IMPORT_ATTRIBUTES,
} LineBreakRule;

static bool scan_after_line_break(TSLexer *lexer, const bool *valid_symbols, bool after_block_arrow,
                                  LineBreakRule rule, bool *scanned_comment);

static bool scan_automatic_semicolon(TSLexer *lexer, const bool *valid_symbols, bool after_block_arrow,
                                     LineBreakRule rule, bool *scanned_comment) {
    lexer->result_symbol = AUTOMATIC_SEMICOLON;
    lexer->mark_end(lexer);

    // A line terminator, also one inside a block comment, separates statements.
    for (bool at_line_break = false; !at_line_break;) {
        if (lexer->eof(lexer) || lexer->is_at_included_range_start(lexer)) {
            return true;
        }
        if (lexer->lookahead == '}') {
            // Automatic semicolon insertion breaks detection of object patterns
            // in a typed context:
            //   type F = ({a}: {a: number}) => number;
            // Therefore, disable automatic semicolons when followed by typing
            do {
                skip(lexer);
            } while (is_whitespace(lexer->lookahead));
            if (lexer->lookahead == ':') {
                return valid_symbols[LOGICAL_OR]; // Don't return false if we're in a ternary by checking if || is valid
            }
            return true;
        }
        if (lexer->lookahead == '/') {
            // A comment on the same line stays in the statement: the scanner runs again after it. The exceptions are a
            // block comment containing a line terminator, since the scanner cannot see that line break after it, and a
            // comment after an arrow function's block body, which would otherwise become part of the arrow function.
            CommentResult result = skip_comment(lexer, scanned_comment);
            if (result == NO_COMMENT || (result == COMMENT && !after_block_arrow)) {
                return false;
            }
            at_line_break = result == COMMENT_WITH_LINE_TERMINATOR;
        } else if (is_whitespace(lexer->lookahead)) {
            at_line_break = is_line_terminator(lexer->lookahead);
            skip(lexer);
        } else {
            return false;
        }
    }

    return scan_after_line_break(lexer, valid_symbols, after_block_arrow, rule, scanned_comment);
}

static bool scan_after_line_break(TSLexer *lexer, const bool *valid_symbols, bool after_block_arrow,
                                  LineBreakRule rule, bool *scanned_comment) {
    if (after_block_arrow) {
        return ends_statement_after_block_arrow(lexer, scanned_comment);
    }

    bool before_slash = !scan_whitespace_and_comments(lexer, scanned_comment);
    // A `;` at the start of the next line ends the statement itself.
    if (!before_slash && lexer->lookahead == ';') {
        return false;
    }
    switch (rule) {
        case LINE_BREAK_ENDS:
            // A token that can start a statement starts the next one; any other token is left to the rules below,
            // which keep a bare `yield` continued by an enclosing `,` or `:`, and `yield` as a script's identifier
            // continued by an operator.
            switch (lexer->lookahead) {
                case '`':
                case '[':
                case '(':
                case '+':
                case '-':
                case '<':
                    return true;
                default:
                    if (before_slash) {
                        return true;
                    }
                    break;
            }
            break;
        case LINE_BREAK_AFTER_BINDING_NAME:
            // A type annotation may also follow on the next line.
            return before_slash || (lexer->lookahead != '=' && lexer->lookahead != ',' && lexer->lookahead != ':');
        case LINE_BREAK_AFTER_FIELD_NAME:
            // Besides an initializer and a method's parameters, a `?`, a type annotation, or a method's type
            // parameters may follow on the next line; a `!` must stay on the name's line.
            switch (lexer->lookahead) {
                case '=':
                case '(':
                case '<':
                case '?':
                case ':':
                    return before_slash;
                default:
                    return true;
            }
        // A decorator cannot follow a modifier, so an `@` also ends a field named by the word.
        case LINE_BREAK_AFTER_MODIFIER_WORD:
            return !before_slash && (lexer->lookahead == '}' || lexer->lookahead == '@' || lexer->eof(lexer));
        case LINE_BREAK_BEFORE_IMPORT_ATTRIBUTES:
            return before_slash || !scan_word(lexer, "with");
        case LINE_BREAK_AFTER_ACCESSOR_WORD:
            return !before_slash && (lexer->lookahead == '}' || lexer->lookahead == '*' || lexer->lookahead == '@' ||
                                     lexer->eof(lexer));
        default:
            break;
    }
    if (before_slash) {
        return false;
    }

    switch (lexer->lookahead) {
        case '`':
        case ',':
        case ';':
        case '*':
        case '%':
        case '>':
        case '<':
        case '=':
        case '?':
        case '^':
        case '|':
        case '&':
        case '/':
        case ':':
            return false;

        // Insert a semicolon before a decimal literal such as `.5`, but not before a member access.
        case '.':
            skip(lexer);
            return is_ascii_digit(lexer->lookahead);

        case '{':
            if (valid_symbols[FUNCTION_SIGNATURE_AUTOMATIC_SEMICOLON]) {
                return false;
            }
            break;

            // Don't insert a semicolon before a '[' or '(', unless we're parsing
            // a type. Detect whether we're parsing a type or an expression using
            // the validity of a binary operator token.
        case '(':
        case '[':
            if (valid_symbols[LOGICAL_OR]) {
                return false;
            }
            break;

            // Insert a semicolon before `--` and `++`, but not before binary `+` or `-`.
        case '+':
            skip(lexer);
            return lexer->lookahead == '+';
        case '-':
            skip(lexer);
            return lexer->lookahead == '-';

            // Don't insert a semicolon before `!=`, but do insert one before a unary `!`.
        case '!':
            skip(lexer);
            return lexer->lookahead != '=';

            // Don't insert a semicolon before `in` or `instanceof`, but do insert one
            // before an identifier.
        case 'i':
            skip(lexer);

            if (lexer->lookahead != 'n') {
                return true;
            }
            skip(lexer);

            if (!is_identifier_part(lexer->lookahead)) {
                return false;
            }

            for (unsigned i = 0; i < 8; i++) {
                if (lexer->lookahead != "stanceof"[i]) {
                    return true;
                }
                skip(lexer);
            }

            if (!is_identifier_part(lexer->lookahead)) {
                return false;
            }
            break;
    }

    return true;
}

static bool scan_ternary_qmark(TSLexer *lexer) {
    for (;;) {
        if (!is_whitespace(lexer->lookahead)) {
            break;
        }
        skip(lexer);
    }

    if (lexer->lookahead == '?') {
        advance(lexer);

        // `??` is an operator; `?.` is optional chaining unless a digit follows, as in `a?.1:.2`, which the check
        // below tells apart.
        if (lexer->lookahead == '?') {
            return false;
        }

        lexer->mark_end(lexer);
        lexer->result_symbol = TERNARY_QMARK;

        /* TypeScript optional arguments contain the ?: sequence, possibly
           with whitespace. */
        for (;;) {
            if (!is_whitespace(lexer->lookahead)) {
                break;
            }
            advance(lexer);
        }

        if (lexer->lookahead == ':' || lexer->lookahead == ')' || lexer->lookahead == ',') {
            return false;
        }

        if (lexer->lookahead == '.') {
            advance(lexer);
            if (is_ascii_digit(lexer->lookahead)) {
                return true;
            }
            return false;
        }
        return true;
    }
    return false;
}

static bool scan_closing_comment(TSLexer *lexer) {
    while (is_whitespace(lexer->lookahead)) {
        skip(lexer);
    }

    const char *comment_start = "<!--";
    const char *comment_end = "-->";

    if (lexer->lookahead == '<') {
        for (unsigned i = 0; i < 4; i++) {
            if (lexer->lookahead != comment_start[i]) {
                return false;
            }
            advance(lexer);
        }
    } else if (lexer->lookahead == '-') {
        for (unsigned i = 0; i < 3; i++) {
            if (lexer->lookahead != comment_end[i]) {
                return false;
            }
            advance(lexer);
        }
    } else {
        return false;
    }

    while (!lexer->eof(lexer) && !is_line_terminator(lexer->lookahead)) {
        advance(lexer);
    }

    lexer->result_symbol = HTML_COMMENT;
    lexer->mark_end(lexer);

    return true;
}

static inline bool is_hex_digit(int32_t c) { return is_ascii_digit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }

// Consumes the `&` at the lookahead and the characters after it that could continue an html_character_reference, and
// returns whether they form a complete one, i.e. whether the grammar's html_character_reference matches here.
static bool scan_character_reference(TSLexer *lexer) {
    advance(lexer);
    unsigned length = 0;
    if (lexer->lookahead == '#') {
        advance(lexer);
        bool hex = lexer->lookahead == 'x' || lexer->lookahead == 'X';
        if (hex) {
            advance(lexer);
        }
        unsigned max_length = hex ? 6 : 5;
        while (length < max_length && (hex ? is_hex_digit(lexer->lookahead) : is_ascii_digit(lexer->lookahead))) {
            advance(lexer);
            length++;
        }
    } else {
        while (length < 30 && is_ascii_letter(lexer->lookahead)) {
            advance(lexer);
            length++;
        }
    }
    return length > 0 && lexer->lookahead == ';';
}

static bool scan_jsx_text(TSLexer *lexer) {
    // saw_text will be true if we see any non-whitespace content, or any whitespace content that is not a newline and
    // does not immediately follow a newline.
    bool saw_text = false;
    // at_newline will be true if we are currently at a newline, or if we are at whitespace that is not a newline but
    // immediately follows a newline.
    bool at_newline = false;

    lexer->result_symbol = JSX_TEXT;
    for (;;) {
        lexer->mark_end(lexer);
        if (lexer->eof(lexer)) {
            return saw_text;
        }
        switch (lexer->lookahead) {
            case '<':
            case '>':
            case '{':
            case '}':
                return saw_text;
            case '&':
                // A complete character reference ends the text; any other `&` is a literal character, as in HTML.
                if (scan_character_reference(lexer)) {
                    return saw_text;
                }
                saw_text = true;
                at_newline = false;
                continue;
            default:
                break;
        }

        // Only ASCII whitespace counts, as with iswspace in the C locale, whereas the C library of the Wasm build also
        // reports Unicode spaces.
        bool is_wspace = (lexer->lookahead >= '\t' && lexer->lookahead <= '\r') || lexer->lookahead == ' ';
        if (lexer->lookahead == '\n' || lexer->lookahead == '\r') {
            at_newline = true;
        } else {
            // If at_newline is already true, and we see some whitespace, then it must stay true.
            // Otherwise, it should be false.
            //
            // See the table below to determine the logic for computing `saw_text`.
            //
            // |------------------------------------|
            // | at_newline | is_wspace | saw_text  |
            // |------------|-----------|-----------|
            // | false (0)  | false (0) | true  (1) |
            // | false (0)  | true  (1) | true  (1) |
            // | true  (1)  | false (0) | true  (1) |
            // | true  (1)  | true  (1) | false (0) |
            // |------------------------------------|

            at_newline &= is_wspace;
            if (!at_newline) {
                saw_text = true;
            }
        }

        advance(lexer);
    }
}

// The reserved words that TypeScript does not read as the start of an expression: after type arguments, they end the
// type arguments like a token that cannot start an expression, while `in`, `instanceof`, `as`, and `satisfies` end them
// as binary operators.
static const char *const WORDS_ENDING_TYPE_ARGUMENTS[] = {
    "as",     "break", "case",      "catch",  "const", "continue", "debugger", "default", "do",
    "else",   "enum",  "export",    "extends", "finally", "for",   "if",       "in",      "instanceof",
    "return", "satisfies", "switch", "throw", "try",   "var",      "while",    "with",
};

typedef enum {
    TYPE_ARGUMENTS_REJECTED,
    TYPE_ARGUMENTS_KEPT,
    // Kept only because a line break precedes the next token, which then could also continue comparisons.
    TYPE_ARGUMENTS_KEPT_AT_LINE_BREAK,
} TypeArgumentsEnd;

// Decides, after the `>` of type arguments in an expression, whether TypeScript keeps them as type arguments rather
// than reading the `<` and `>` as comparisons (`canFollowTypeArgumentsInExpression` in TypeScript's parser): a line
// break, a binary operator, or a token that cannot start an expression must follow, and never `<`, `>`, `+`, or `-`.
// A `(` or a template literal also keeps them, but there the grammar's call and `new` rules take the type arguments
// instead of these tokens. TypeScript reads a `>` that `=` or `>` immediately follows as part of `>=` or `>>`, so it
// closes no type arguments.
//
// After `new A<T>`, a `.` or `[` continues the constructor (`new A<T>\n[0]` constructs `A<T>[0]`), so the scanner then
// ends the type arguments of an instantiation expression in the constructor rather than those of the `new`.
static TypeArgumentsEnd scan_type_arguments_end_context(TSLexer *lexer, bool *continues_member);

static bool scan_type_arguments_end(TSLexer *lexer, const bool *valid_symbols) {
    lexer->mark_end(lexer);
    bool continues_member = false;
    TypeArgumentsEnd end = scan_type_arguments_end_context(lexer, &continues_member);
    if (end == TYPE_ARGUMENTS_REJECTED) {
        return false;
    }
    if (valid_symbols[NEW_TYPE_ARGUMENTS_END] && !(continues_member && valid_symbols[TYPE_ARGUMENTS_END])) {
        lexer->result_symbol = NEW_TYPE_ARGUMENTS_END;
    } else {
        lexer->result_symbol =
            end == TYPE_ARGUMENTS_KEPT_AT_LINE_BREAK ? TYPE_ARGUMENTS_END_AT_LINE_BREAK : TYPE_ARGUMENTS_END;
    }
    return true;
}

static TypeArgumentsEnd scan_type_arguments_end_context(TSLexer *lexer, bool *continues_member) {
    if (lexer->lookahead == '=' || lexer->lookahead == '>') {
        return TYPE_ARGUMENTS_REJECTED;
    }

    bool line_break = false;
    for (;;) {
        if (is_whitespace(lexer->lookahead)) {
            line_break |= is_line_terminator(lexer->lookahead);
            skip(lexer);
        } else if (lexer->lookahead == '/') {
            bool scanned_comment = false;
            CommentResult result = skip_comment(lexer, &scanned_comment);
            if (result == NO_COMMENT) {
                // A `/=` starts a regex, and a `/` is a division.
                if (lexer->lookahead != '=') {
                    return TYPE_ARGUMENTS_KEPT;
                }
                return line_break ? TYPE_ARGUMENTS_KEPT_AT_LINE_BREAK : TYPE_ARGUMENTS_REJECTED;
            }
            line_break |= result == COMMENT_WITH_LINE_TERMINATOR;
        } else {
            break;
        }
    }
    TypeArgumentsEnd before_expression = line_break ? TYPE_ARGUMENTS_KEPT_AT_LINE_BREAK : TYPE_ARGUMENTS_REJECTED;

    switch (lexer->lookahead) {
        case '(':
        case '`':
        case '>':
            return TYPE_ARGUMENTS_REJECTED;
        case '<':
            skip(lexer);
            return lexer->lookahead == '<' || lexer->lookahead == '=' ? TYPE_ARGUMENTS_KEPT : TYPE_ARGUMENTS_REJECTED;
        case '+':
        case '-': {
            int32_t sign = lexer->lookahead;
            skip(lexer);
            // `++` and `--` start an expression, `+=` and `-=` cannot.
            if (lexer->lookahead == '=') {
                return TYPE_ARGUMENTS_KEPT;
            }
            return lexer->lookahead == sign ? before_expression : TYPE_ARGUMENTS_REJECTED;
        }
        case '.':
            skip(lexer);
            if (lexer->lookahead == '.') {
                return TYPE_ARGUMENTS_KEPT;
            }
            // `.5` is a number.
            if (is_ascii_digit(lexer->lookahead)) {
                return before_expression;
            }
            *continues_member = true;
            return TYPE_ARGUMENTS_KEPT;
        case '[':
            *continues_member = true;
            return before_expression;
        case '!':
            skip(lexer);
            return lexer->lookahead == '=' ? TYPE_ARGUMENTS_KEPT : before_expression;
        case '{':
        case '~':
        case '\'':
        case '"':
        case '#':
        case '@':
            return before_expression;
        default:
            break;
    }
    if (lexer->eof(lexer) || !is_identifier_part(lexer->lookahead)) {
        return TYPE_ARGUMENTS_KEPT;
    }
    if (is_ascii_digit(lexer->lookahead)) {
        return before_expression;
    }

    char word[16];
    unsigned length = 0;
    while (lexer->lookahead >= 'a' && lexer->lookahead <= 'z' && length < sizeof(word) - 1) {
        word[length++] = (char)lexer->lookahead;
        skip(lexer);
    }
    word[length] = '\0';
    if (length == 0 || is_identifier_part(lexer->lookahead)) {
        return before_expression;
    }
    if (strcmp(word, "import") == 0) {
        // `import` starts an expression only as `import(...)`, `import.meta`, or `import<T>` (an error TypeScript
        // recovers from).
        bool scanned_comment = false;
        if (scan_whitespace_and_comments(lexer, &scanned_comment) &&
            (lexer->lookahead == '(' || lexer->lookahead == '.' || lexer->lookahead == '<')) {
            return before_expression;
        }
        return TYPE_ARGUMENTS_KEPT;
    }
    for (unsigned i = 0; i < sizeof(WORDS_ENDING_TYPE_ARGUMENTS) / sizeof(WORDS_ENDING_TYPE_ARGUMENTS[0]); i++) {
        if (strcmp(word, WORDS_ENDING_TYPE_ARGUMENTS[i]) == 0) {
            return TYPE_ARGUMENTS_KEPT;
        }
    }
    return before_expression;
}

static inline bool external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
    Scanner *scanner = (Scanner *)payload;

    if (valid_symbols[TEMPLATE_CHARS]) {
        if (valid_symbols[AUTOMATIC_SEMICOLON]) {
            return false;
        }
        return scan_template_chars(lexer);
    }

    if (scanner->automatic_semicolon_pending &&
        (valid_symbols[AUTOMATIC_SEMICOLON] || valid_symbols[ARROW_FUNCTION_BLOCK_CONTINUATION])) {
        scanner->automatic_semicolon_pending = false;
        lexer->result_symbol =
            valid_symbols[AUTOMATIC_SEMICOLON] ? AUTOMATIC_SEMICOLON : ARROW_FUNCTION_BLOCK_CONTINUATION;
        lexer->mark_end(lexer);
        return true;
    }

    if (valid_symbols[TYPE_ARGUMENTS_END] || valid_symbols[TYPE_ARGUMENTS_END_AT_LINE_BREAK] ||
        valid_symbols[NEW_TYPE_ARGUMENTS_END]) {
        return scan_type_arguments_end(lexer, valid_symbols);
    }

    if (valid_symbols[JSX_TEXT] && scan_jsx_text(lexer)) {
        return true;
    }

    if (valid_symbols[AUTOMATIC_SEMICOLON] || valid_symbols[FUNCTION_SIGNATURE_AUTOMATIC_SEMICOLON] ||
        valid_symbols[ARROW_FUNCTION_BLOCK_END]) {
        bool after_block_arrow = valid_symbols[ARROW_FUNCTION_BLOCK_END];
        bool scanned_comment = false;
        LineBreakRule rule = LINE_BREAK_BY_NEXT_TOKEN;
        if (valid_symbols[LINE_BREAK_ENDS_STATEMENT]) {
            rule = LINE_BREAK_ENDS;
        } else if (valid_symbols[LINE_BREAK_AFTER_BINDING]) {
            rule = LINE_BREAK_AFTER_BINDING_NAME;
        } else if (valid_symbols[LINE_BREAK_AFTER_MODIFIER]) {
            rule = valid_symbols[LINE_BREAK_AFTER_FIELD] ? LINE_BREAK_AFTER_ACCESSOR_WORD : LINE_BREAK_AFTER_MODIFIER_WORD;
        } else if (valid_symbols[LINE_BREAK_AFTER_FIELD]) {
            rule = LINE_BREAK_AFTER_FIELD_NAME;
        } else if (valid_symbols[LINE_BREAK_BEFORE_ATTRIBUTES]) {
            rule = LINE_BREAK_BEFORE_IMPORT_ATTRIBUTES;
        }
        bool ret = scan_automatic_semicolon(lexer, valid_symbols, after_block_arrow, rule, &scanned_comment);
        if (ret && after_block_arrow) {
            lexer->result_symbol = ARROW_FUNCTION_BLOCK_END;
            scanner->automatic_semicolon_pending = true;
        }
        if (!ret && !scanned_comment && valid_symbols[TERNARY_QMARK] && lexer->lookahead == '?') {
            return scan_ternary_qmark(lexer);
        }
        return ret;
    }
    if (valid_symbols[TERNARY_QMARK]) {
        return scan_ternary_qmark(lexer);
    }

    if (valid_symbols[HTML_COMMENT] && !valid_symbols[LOGICAL_OR] && !valid_symbols[ESCAPE_SEQUENCE] &&
        !valid_symbols[REGEX_PATTERN]) {
        return scan_closing_comment(lexer);
    }

    return false;
}
