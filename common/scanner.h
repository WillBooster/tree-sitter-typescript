#include "tree_sitter/alloc.h"
#include "tree_sitter/parser.h"

#include <wctype.h>

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
    FUNCTION_SIGNATURE_AUTOMATIC_SEMICOLON,
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
        switch (lexer->lookahead) {
            case '`':
                return has_content;
            case '\0':
                return false;
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

static bool scan_whitespace_and_comments(TSLexer *lexer, bool *scanned_comment) {
    for (;;) {
        while (iswspace(lexer->lookahead) || is_line_terminator(lexer->lookahead)) {
            skip(lexer);
        }

        if (lexer->lookahead == '/') {
            skip(lexer);

            if (lexer->lookahead == '/') {
                skip(lexer);
                while (lexer->lookahead != 0 && !is_line_terminator(lexer->lookahead)) {
                    skip(lexer);
                }
                *scanned_comment = true;
            } else if (lexer->lookahead == '*') {
                skip(lexer);
                while (lexer->lookahead != 0) {
                    if (lexer->lookahead == '*') {
                        skip(lexer);
                        if (lexer->lookahead == '/') {
                            skip(lexer);
                            break;
                        }
                    } else {
                        skip(lexer);
                    }
                }
            } else {
                return false;
            }
        } else {
            return true;
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
        while (lexer->lookahead != 0 && !is_line_terminator(lexer->lookahead)) {
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
    while (lexer->lookahead != 0) {
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

static bool scan_automatic_semicolon(TSLexer *lexer, const bool *valid_symbols, bool after_block_arrow,
                                     bool *scanned_comment) {
    lexer->result_symbol = AUTOMATIC_SEMICOLON;
    lexer->mark_end(lexer);

    for (;;) {
        if (lexer->lookahead == 0) {
            return true;
        }
        if (lexer->lookahead == '}') {
            // Automatic semicolon insertion breaks detection of object patterns
            // in a typed context:
            //   type F = ({a}: {a: number}) => number;
            // Therefore, disable automatic semicolons when followed by typing
            do {
                skip(lexer);
            } while (iswspace(lexer->lookahead));
            if (lexer->lookahead == ':') {
                return valid_symbols[LOGICAL_OR]; // Don't return false if we're in a ternary by checking if || is valid
            }
            return true;
        }
        if (after_block_arrow) {
            // The line terminator after an arrow function's block body may also be in a comment or be a lone CR, U+2028,
            // or U+2029.
            if (lexer->lookahead == '/') {
                CommentResult result = skip_comment(lexer, scanned_comment);
                if (result == NO_COMMENT) {
                    return false;
                }
                if (result == COMMENT_WITH_LINE_TERMINATOR) {
                    return ends_statement_after_block_arrow(lexer, scanned_comment);
                }
                continue;
            }
            if (is_line_terminator(lexer->lookahead)) {
                break;
            }
        }
        if (!iswspace(lexer->lookahead)) {
            return false;
        }
        if (lexer->lookahead == '\n') {
            break;
        }
        skip(lexer);
    }

    skip(lexer);

    if (after_block_arrow) {
        return ends_statement_after_block_arrow(lexer, scanned_comment);
    }

    if (!scan_whitespace_and_comments(lexer, scanned_comment)) {
        return false;
    }

    switch (lexer->lookahead) {
        case '`':
        case ',':
        case '.':
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

            if (!iswalpha(lexer->lookahead)) {
                return false;
            }

            for (unsigned i = 0; i < 8; i++) {
                if (lexer->lookahead != "stanceof"[i]) {
                    return true;
                }
                skip(lexer);
            }

            if (!iswalpha(lexer->lookahead)) {
                return false;
            }
            break;
    }

    return true;
}

static bool scan_ternary_qmark(TSLexer *lexer) {
    for (;;) {
        if (!iswspace(lexer->lookahead)) {
            break;
        }
        skip(lexer);
    }

    if (lexer->lookahead == '?') {
        advance(lexer);

        /* Optional chaining. */
        if (lexer->lookahead == '?' || lexer->lookahead == '.') {
            return false;
        }

        lexer->mark_end(lexer);
        lexer->result_symbol = TERNARY_QMARK;

        /* TypeScript optional arguments contain the ?: sequence, possibly
           with whitespace. */
        for (;;) {
            if (!iswspace(lexer->lookahead)) {
                break;
            }
            advance(lexer);
        }

        if (lexer->lookahead == ':' || lexer->lookahead == ')' || lexer->lookahead == ',') {
            return false;
        }

        if (lexer->lookahead == '.') {
            advance(lexer);
            if (iswdigit(lexer->lookahead)) {
                return true;
            }
            return false;
        }
        return true;
    }
    return false;
}

static bool scan_closing_comment(TSLexer *lexer) {
    while (iswspace(lexer->lookahead) || lexer->lookahead == 0x2028 || lexer->lookahead == 0x2029) {
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

    while (lexer->lookahead != 0 && lexer->lookahead != '\n' && lexer->lookahead != 0x2028 &&
           lexer->lookahead != 0x2029) {
        advance(lexer);
    }

    lexer->result_symbol = HTML_COMMENT;
    lexer->mark_end(lexer);

    return true;
}

static inline bool is_ascii_letter(int32_t c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }

static inline bool is_ascii_digit(int32_t c) { return c >= '0' && c <= '9'; }

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
        switch (lexer->lookahead) {
            case 0:
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

        bool is_wspace = iswspace(lexer->lookahead);
        if (lexer->lookahead == '\n') {
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

    if (valid_symbols[JSX_TEXT] && scan_jsx_text(lexer)) {
        return true;
    }

    if (valid_symbols[AUTOMATIC_SEMICOLON] || valid_symbols[FUNCTION_SIGNATURE_AUTOMATIC_SEMICOLON] ||
        valid_symbols[ARROW_FUNCTION_BLOCK_END]) {
        bool after_block_arrow = valid_symbols[ARROW_FUNCTION_BLOCK_END];
        bool scanned_comment = false;
        bool ret = scan_automatic_semicolon(lexer, valid_symbols, after_block_arrow, &scanned_comment);
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
