#include "tree_sitter/alloc.h"
#include "tree_sitter/parser.h"

#include <string.h>
#include "typeScriptKeywords.h"

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
    STATEMENT_BOUNDARY,
    LINE_BREAK_AFTER_AWAIT,
    AWAIT_IDENTIFIER_LINE_BREAK,
    AWAIT_OPERAND_END,
    COMPLETED_ARROW_FUNCTION,
    AWAIT_YIELD_IDENTIFIER,
    AWAIT_YIELD_IDENTIFIER_START,
    AWAIT_YIELD_IDENTIFIER_CONTEXT,
    POSTFIX_UPDATE_END,
    AWAIT_KEYWORD,
    LET,
    SINGLE_STATEMENT_CONTEXT,
    RESOURCE_BINDING_START,
    RESOURCE_BINDING_CONTINUATION,
    PLAIN_RESOURCE_FOR_OF_CONTEXT,
    EXPORT_DEFAULT,
    DEFAULT_DECLARATION_START,
    REGEX_FLAGS_START,
    FUNCTION_SIGNATURE_AUTOMATIC_SEMICOLON,
    TYPE_ARGUMENTS_END,
    TYPE_ARGUMENTS_END_BEFORE_EXPRESSION,
    NEW_TYPE_ARGUMENTS_END,
    TYPE_REFERENCE_ARGUMENTS_START,
    UNQUALIFIED_TYPE_REFERENCE_ARGUMENTS_START,
    TYPE_MEMBER_SEMICOLON,
    HERITAGE_TYPE_START,
    HERITAGE_TYPE_END,
    GLOBAL_DECLARATION_START,
    GLOBAL_DECLARATION_END,
    ERROR_RECOVERY,
    NAMESPACE_EXPRESSION_END,
    ABSTRACT_CONSTRUCTOR_PREFIX,
    JSX_CLOSING_RECOVERY_IDENTIFIER,
    PREDEFINED_PARAMETER_NAME,
    PREDEFINED_ANNOTATED_NAME,
};

static bool scan_let(TSLexer *lexer);
static bool is_reserved_word(const char *name);

typedef struct {
    // A reused block arrow or postfix update can bypass the boundary state; serialize the pending semicolon.
    // Nested await end tokens must not clear it before the enclosing statement consumes it.
    bool automatic_semicolon_pending;
    bool heritage_type_pending;
    bool default_declaration_pending;
} Scanner;

static bool scan_export_default(Scanner *scanner, TSLexer *lexer);
static bool scan_default_trivia(TSLexer *lexer, bool allow_line_breaks, bool html_comments);
static bool scan_jsx_closing_recovery_identifier(TSLexer *lexer);

static inline void *external_scanner_create() { return ts_calloc(1, sizeof(Scanner)); }

static inline void external_scanner_destroy(void *payload) { ts_free(payload); }

static inline unsigned external_scanner_serialize(void *payload, char *buffer) {
    Scanner *scanner = (Scanner *)payload;
    buffer[0] = (char)scanner->automatic_semicolon_pending;
    buffer[1] = (char)scanner->heritage_type_pending;
    buffer[2] = (char)scanner->default_declaration_pending;
    return 3;
}

static inline void external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
    Scanner *scanner = (Scanner *)payload;
    scanner->automatic_semicolon_pending = length > 0 && buffer[0];
    scanner->heritage_type_pending = length > 1 && buffer[1];
    scanner->default_declaration_pending = length > 2 && buffer[2];
}

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

static inline bool is_line_terminator(int32_t c) { return c == '\n' || c == '\r' || c == 0x2028 || c == 0x2029; }

// The characters of the whitespace class in the grammar's extras (which includes the line terminators). iswspace
// depends on the C library and locale and differs from that class.
static inline bool is_whitespace(int32_t c) {
    switch (c) {
        case '\t':
        case '\n':
        case '\v':
        case '\f':
        case '\r':
        case ' ':
        case 0xA0:
        case 0x1680:
        case 0x200B:
        case 0x2028:
        case 0x2029:
        case 0x202F:
        case 0x205F:
        case 0x2060:
        case 0x3000:
        case 0xFEFF:
            return true;
        default:
            return c >= 0x2000 && c <= 0x200A;
    }
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

typedef enum {
    NO_COMMENT,
    COMMENT,
    COMMENT_WITH_LINE_TERMINATOR,
} CommentResult;

// Skips the comment that the `/` at the lookahead starts, if any. A line comment ends before its line terminator, which
// the caller then sees; a block comment reports whether it contains one, since it then separates lines as well.
static CommentResult skip_comment(TSLexer *lexer, bool *scanned_comment, bool skip_input) {
    lexer->advance(lexer, skip_input);
    if (lexer->lookahead == '/') {
        while (!lexer->eof(lexer) && !is_line_terminator(lexer->lookahead)) {
            lexer->advance(lexer, skip_input);
        }
        *scanned_comment = true;
        return COMMENT;
    }
    if (lexer->lookahead != '*') {
        return NO_COMMENT;
    }
    lexer->advance(lexer, skip_input);
    bool saw_line_terminator = false;
    while (!lexer->eof(lexer)) {
        if (lexer->lookahead == '*') {
            lexer->advance(lexer, skip_input);
            if (lexer->lookahead == '/') {
                lexer->advance(lexer, skip_input);
                break;
            }
        } else {
            saw_line_terminator |= is_line_terminator(lexer->lookahead);
            lexer->advance(lexer, skip_input);
        }
    }
    *scanned_comment = true;
    return saw_line_terminator ? COMMENT_WITH_LINE_TERMINATOR : COMMENT;
}

// Returns false at a `/` that starts no comment.
static bool scan_type_whitespace_and_comments(TSLexer *lexer, bool *scanned_comment, bool skip_input) {
    for (;;) {
        while (is_whitespace(lexer->lookahead)) {
            lexer->advance(lexer, skip_input);
        }
        if (lexer->lookahead != '/') {
            return true;
        }
        if (skip_comment(lexer, scanned_comment, skip_input) == NO_COMMENT) {
            return false;
        }
    }
}

typedef enum {
    REJECT,     // Semicolon is illegal, ie a syntax error occurred
    NO_NEWLINE, // Unclear if semicolon will be legal, continue
    ACCEPT,     // Semicolon is legal, assuming a comment was encountered
    // Like ACCEPT, but the line break is inside the block comment that the lexer stopped after, so it will not be seen
    // again once tree-sitter has consumed that comment.
    ACCEPT_IN_BLOCK_COMMENT,
    ACCEPT_IN_BLOCK_COMMENT_BEFORE_SLASH,
} WhitespaceResult;

/**
 * @param consume If false, only consume enough to check if comment indicates semicolon-legality
 */
static WhitespaceResult scan_whitespace_and_comments(TSLexer *lexer, bool *scanned_content, bool consume, bool skip_contents) {
    bool saw_block_newline = false;

    for (;;) {
        while (is_whitespace(lexer->lookahead)) {
            lexer->advance(lexer, skip_contents);
        }

        if (lexer->lookahead == '/') {
            lexer->advance(lexer, skip_contents);

            if (lexer->lookahead == '/') {
                lexer->advance(lexer, skip_contents);
                while (!lexer->eof(lexer) && !is_line_terminator(lexer->lookahead)) {
                    lexer->advance(lexer, skip_contents);
                }
                *scanned_content = true;
                if (!consume) return ACCEPT;
            } else if (lexer->lookahead == '*') {
                lexer->advance(lexer, skip_contents);
                while (!lexer->eof(lexer)) {
                    if (lexer->lookahead == '*') {
                        lexer->advance(lexer, skip_contents);
                        if (lexer->lookahead == '/') {
                            lexer->advance(lexer, skip_contents);
                            *scanned_content = true;

                            if (!consume && lexer->lookahead != '/') {
                                return saw_block_newline ? ACCEPT_IN_BLOCK_COMMENT : NO_NEWLINE;
                            }

                            break;
                        }
                    } else if (is_line_terminator(lexer->lookahead)) {
                        saw_block_newline = true;
                        lexer->advance(lexer, skip_contents);
                    } else {
                        lexer->advance(lexer, skip_contents);
                    }
                }
            } else {
                return !consume && saw_block_newline ? ACCEPT_IN_BLOCK_COMMENT_BEFORE_SLASH : REJECT;
            }
        } else {
            return ACCEPT;
        }
    }
}

// Called after an arrow function's block body and a line break: such a function cannot be continued by a member
// access, call, or operator, so the statement ends unless a `,` continues the list, a `;` ends it explicitly, or a `?`
// continues an enclosing conditional expression (`a ? b : () => {}` then `? c : d`, which V8 accepts).
static bool ends_statement_after_block_arrow(TSLexer *lexer, bool *scanned_content) {
    // REJECT means a `/` that starts no comment, i.e. a regex.
    if (scan_whitespace_and_comments(lexer, scanned_content, true, true) == REJECT) {
        return true;
    }
    return lexer->lookahead != ',' && lexer->lookahead != ';' && lexer->lookahead != '?';
}

// What a line break after the preceding token means, told by the sentinel external tokens that the grammar allows
// only at these positions; the scanner never emits them.
typedef enum {
    // Decided by the characters that follow.
    LINE_BREAK_BY_NEXT_TOKEN,
    // After restricted statement keywords or a completed type member; type operators may still continue a member.
    LINE_BREAK_ENDS,
    LINE_BREAK_AFTER_BINDING_NAME,
    LINE_BREAK_AFTER_FIELD_NAME,
    // After `static` at the start of a class member: a line break continues the member unless a `}`, a `@` (decorators
    // precede modifiers), or the end of input follows, which leaves a field named `static`.
    LINE_BREAK_AFTER_MODIFIER_WORD,
    // After `get` or `set` at the start of a class member: as after `static`, except that a `*` also ends the field,
    // since an accessor cannot be a generator.
    LINE_BREAK_AFTER_ACCESSOR_WORD,
    // After the source of an import or re-export: only the `with` of its attributes continues it.
    LINE_BREAK_BEFORE_IMPORT_ATTRIBUTES,
    LINE_BREAK_AFTER_AWAIT_KEYWORD,
} LineBreakRule;

static bool scan_after_line_break(TSLexer *lexer, const bool *valid_symbols, bool after_block_arrow, LineBreakRule rule, bool *scanned_content, bool before_slash);
static bool scan_identifier(TSLexer *lexer, char *word, unsigned capacity, bool skip_contents);
static bool follows_yield_operand(TSLexer *lexer);
static bool scan_resource_binding(TSLexer *lexer, bool plain_for_of, bool after_line_break, bool *infix_operator);

static bool scan_automatic_semicolon(TSLexer *lexer, const bool *valid_symbols, bool comment_condition, bool after_block_arrow,
                                     LineBreakRule rule, bool *scanned_content, bool *before_line_break, bool allow_resource_binding) {
    *before_line_break = false;
    lexer->result_symbol = AUTOMATIC_SEMICOLON;
    lexer->mark_end(lexer);
    bool line_break_in_block_comment = false;
    bool resource_line_break = false;

    for (;;) {
        if (lexer->eof(lexer)) {
            return true;
        }

        if (lexer->lookahead == '/') {
            WhitespaceResult result = scan_whitespace_and_comments(lexer, scanned_content, false, true);
            if (result == REJECT) {
                return false;
            }
            if (result == ACCEPT_IN_BLOCK_COMMENT_BEFORE_SLASH) {
                return scan_after_line_break(lexer, valid_symbols, after_block_arrow, rule, scanned_content, true);
            }

            if (after_block_arrow && lexer->eof(lexer)) {
                return true;
            }

            if (result == NO_NEWLINE && rule == LINE_BREAK_AFTER_AWAIT_KEYWORD) {
                return false;
            }
            if (result == ACCEPT || result == ACCEPT_IN_BLOCK_COMMENT) {
                resource_line_break = true;
                if (after_block_arrow || rule != LINE_BREAK_BY_NEXT_TOKEN) {
                    return scan_after_line_break(lexer, valid_symbols, after_block_arrow, rule, scanned_content, false);
                }
                if (comment_condition) {
                    return scan_after_line_break(lexer, valid_symbols, false, rule, scanned_content, false);
                }
                if (result == ACCEPT && is_line_terminator(lexer->lookahead)) {
                    return false;
                }
                line_break_in_block_comment = result == ACCEPT_IN_BLOCK_COMMENT;
            }
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

        if (lexer->is_at_included_range_start(lexer)) {
            return true;
        }

        if (is_line_terminator(lexer->lookahead)) {
            break;
        }

        if (!is_whitespace(lexer->lookahead)) {
            *before_line_break = true;
            if (allow_resource_binding && !resource_line_break && is_identifier_part(lexer->lookahead) &&
                !is_ascii_digit(lexer->lookahead)) {
                *scanned_content = true;
                if (scan_resource_binding(lexer, false, false, NULL)) {
                    lexer->result_symbol = RESOURCE_BINDING_START;
                    return true;
                }
                return false;
            }
            // Otherwise tree-sitter consumes the comments and calls the scanner again after them.
            return line_break_in_block_comment && scan_after_line_break(lexer, valid_symbols, false, rule, scanned_content, false);
        }

        skip(lexer);
    }

    skip(lexer);
    return scan_after_line_break(lexer, valid_symbols, after_block_arrow, rule, scanned_content, false);
}

static bool scan_after_line_break(TSLexer *lexer, const bool *valid_symbols, bool after_block_arrow, LineBreakRule rule,
                                  bool *scanned_content, bool before_slash) {
    if (after_block_arrow) {
        return before_slash || ends_statement_after_block_arrow(lexer, scanned_content);
    }

    // REJECT means a `/` that starts no comment.
    before_slash = before_slash || scan_whitespace_and_comments(lexer, scanned_content, true, true) == REJECT;
    // A `;` at the start of the next line ends the statement itself.
    if (!before_slash && lexer->lookahead == ';') {
        return false;
    }
    switch (rule) {
        case LINE_BREAK_AFTER_AWAIT_KEYWORD:
            if (!before_slash && lexer->lookahead == '{') {
                lexer->result_symbol = AWAIT_IDENTIFIER_LINE_BREAK;
                return true;
            }
            if (before_slash) {
                return false;
            }
            if (is_identifier_part(lexer->lookahead) && !is_ascii_digit(lexer->lookahead)) {
                *scanned_content = true;
                char word[16] = {0};
                bool ascii_word = scan_identifier(lexer, word, sizeof(word), true);
                if (ascii_word && strcmp(word, "yield") == 0) {
                    if (follows_yield_operand(lexer)) {
                        return true;
                    }
                    lexer->result_symbol = AWAIT_YIELD_IDENTIFIER_START;
                    return true;
                }
                bool followed_by_trivia = scan_whitespace_and_comments(lexer, scanned_content, true, true) != REJECT;
                if (followed_by_trivia && lexer->lookahead == ':') {
                    return true;
                }
                if (ascii_word && strcmp(word, "async") == 0 && is_identifier_part(lexer->lookahead)) {
                    char parameter[16] = {0};
                    scan_identifier(lexer, parameter, sizeof(parameter), true);
                    scan_whitespace_and_comments(lexer, scanned_content, true, true);
                }
                if (ascii_word && strcmp(word, "async") == 0 && lexer->lookahead == '(') {
                    lexer->result_symbol = AWAIT_IDENTIFIER_LINE_BREAK;
                    return true;
                }
                if (lexer->lookahead == '=') {
                    skip(lexer);
                    return lexer->lookahead != '=';
                }
                if (!ascii_word) {
                    lexer->result_symbol = AWAIT_IDENTIFIER_LINE_BREAK;
                    return true;
                }
                if (strcmp(word, "import") == 0) {
                    return lexer->lookahead != '(' && lexer->lookahead != '.';
                }
                if ((strcmp(word, "using") == 0 || strcmp(word, "let") == 0 ||
                     (strcmp(word, "namespace") == 0 && followed_by_trivia)) && is_identifier_part(lexer->lookahead) && !is_ascii_digit(lexer->lookahead)) {
                    char binding[16] = {0};
                    bool ascii_binding = scan_identifier(lexer, binding, sizeof(binding), true);
                    return !ascii_binding || (strcmp(binding, "in") != 0 && strcmp(binding, "instanceof") != 0);
                }
                static const char *const statements[] = {
                    "break", "case", "catch", "const", "continue", "debugger", "default", "do", "else", "enum",
                    "export", "finally", "for", "if", "return", "switch",
                    "throw", "try", "var", "while", "with",
                };
                for (unsigned i = 0; i < sizeof(statements) / sizeof(statements[0]); i++) {
                    if (strcmp(word, statements[i]) == 0) {
                        return true;
                    }
                }
                lexer->result_symbol = AWAIT_IDENTIFIER_LINE_BREAK;
                return true;
            }
            switch (lexer->lookahead) {
                case '.':
                case '{':
                case '[':
                case '(':
                case '`':
                case '\'':
                case '"':
                case '/':
                case '+':
                case '-':
                case '!':
                case '~':
                case '<':
                    return false;
                default:
                    if (is_ascii_digit(lexer->lookahead)) {
                        return false;
                    }
                    break;
            }
            break;
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
        case LINE_BREAK_AFTER_MODIFIER_WORD:
            return !before_slash && (lexer->lookahead == '}' || lexer->lookahead == '@' || lexer->eof(lexer));
        case LINE_BREAK_BEFORE_IMPORT_ATTRIBUTES:
            if (before_slash || !scan_word(lexer, "with")) return true;
            return scan_whitespace_and_comments(lexer, scanned_content, true, true) == REJECT || lexer->lookahead != '{';
        case LINE_BREAK_AFTER_ACCESSOR_WORD:
            return !before_slash && (lexer->lookahead == '}' || lexer->lookahead == '@' || lexer->lookahead == '*' ||
                                     lexer->eof(lexer));
        default:
            break;
    }
    if (before_slash) {
        return !valid_symbols[LOGICAL_OR] && !valid_symbols[ERROR_RECOVERY];
    }

    switch (lexer->lookahead) {
        case '`':
        case ',':
        case ':':
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
            return false;

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

        default:
            break;
    }

    return true;
}

static bool follows_yield_operand(TSLexer *lexer) {
    for (;;) {
        while (is_whitespace(lexer->lookahead)) {
            if (is_line_terminator(lexer->lookahead)) {
                return false;
            }
            skip(lexer);
        }
        if (lexer->lookahead != '/') {
            break;
        }
        skip(lexer);
        if (lexer->lookahead == '/') {
            return false;
        }
        if (lexer->lookahead != '*') {
            return true;
        }
        skip(lexer);
        for (;;) {
            if (lexer->eof(lexer) || is_line_terminator(lexer->lookahead)) {
                return false;
            }
            bool after_asterisk = lexer->lookahead == '*';
            skip(lexer);
            if (after_asterisk && lexer->lookahead == '/') {
                skip(lexer);
                break;
            }
        }
    }
    if (is_identifier_part(lexer->lookahead)) {
        char word[16] = {0};
        bool ascii_word = scan_identifier(lexer, word, sizeof(word), true);
        return !ascii_word || (strcmp(word, "in") != 0 && strcmp(word, "instanceof") != 0);
    }
    if (lexer->lookahead == '.') {
        skip(lexer);
        return is_ascii_digit(lexer->lookahead);
    }
    if (lexer->lookahead == '+' || lexer->lookahead == '-') {
        int32_t sign = lexer->lookahead;
        skip(lexer);
        if (lexer->lookahead != sign) {
            return false;
        }
        skip(lexer);
        bool scanned_content = false;
        scan_whitespace_and_comments(lexer, &scanned_content, true, true);
        return !lexer->eof(lexer) && lexer->lookahead != ';' && lexer->lookahead != '}' && lexer->lookahead != ')' &&
               lexer->lookahead != ']' && lexer->lookahead != ',' && lexer->lookahead != ':';
    }
    return lexer->lookahead == '*' || lexer->lookahead == ':' || lexer->lookahead == '(' ||
           lexer->lookahead == '[' || lexer->lookahead == '{' || lexer->lookahead == '`' ||
           lexer->lookahead == '\'' || lexer->lookahead == '"' || lexer->lookahead == '!' || lexer->lookahead == '~';
}

static bool scan_identifier(TSLexer *lexer, char *word, unsigned capacity, bool skip_contents) {
    unsigned length = 0;
    bool ascii_word = true;
    while (is_identifier_part(lexer->lookahead)) {
        if (lexer->lookahead == '\\') {
            ascii_word = false;
            lexer->advance(lexer, skip_contents);
            if (lexer->lookahead == 'u') {
                lexer->advance(lexer, skip_contents);
                if (lexer->lookahead == '{') {
                    lexer->advance(lexer, skip_contents);
                    while (is_ascii_digit(lexer->lookahead) ||
                           (lexer->lookahead >= 'a' && lexer->lookahead <= 'f') ||
                           (lexer->lookahead >= 'A' && lexer->lookahead <= 'F')) {
                        lexer->advance(lexer, skip_contents);
                    }
                    if (lexer->lookahead == '}') {
                        lexer->advance(lexer, skip_contents);
                    }
                }
            }
            continue;
        }
        if (lexer->lookahead > 0x7F || length == capacity - 1) {
            ascii_word = false;
        } else {
            word[length++] = (char)lexer->lookahead;
        }
        lexer->advance(lexer, skip_contents);
    }
    return ascii_word;
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

static bool scan_html_comment(TSLexer *lexer) {
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

        // Only ASCII whitespace counts, as in Babel's JSX whitespace trimming; other spaces, such as U+00A0, are text.
        bool is_wspace = (lexer->lookahead >= '\t' && lexer->lookahead <= '\r') || lexer->lookahead == ' ';
        // Babel splits JSX text into lines at CR and LF only, and keeps U+2028 and U+2029 as text.
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
    // Kept before a token that may start an expression, which comparisons could then read as their right operand.
    TYPE_ARGUMENTS_KEPT_BEFORE_EXPRESSION,
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
            end == TYPE_ARGUMENTS_KEPT_BEFORE_EXPRESSION ? TYPE_ARGUMENTS_END_BEFORE_EXPRESSION : TYPE_ARGUMENTS_END;
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
            CommentResult result = skip_comment(lexer, &scanned_comment, true);
            if (result == NO_COMMENT) {
                // TypeScript reads a `/` as a division, which keeps the type arguments, and a `/=` as the start of a
                // regex, which keeps them only after a line break. Either may also start a regex that comparisons read.
                if (lexer->lookahead != '=' || line_break) {
                    return TYPE_ARGUMENTS_KEPT_BEFORE_EXPRESSION;
                }
                return TYPE_ARGUMENTS_REJECTED;
            }
            line_break |= result == COMMENT_WITH_LINE_TERMINATOR;
        } else {
            break;
        }
    }
    TypeArgumentsEnd before_expression = line_break ? TYPE_ARGUMENTS_KEPT_BEFORE_EXPRESSION : TYPE_ARGUMENTS_REJECTED;

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
        if (scan_type_whitespace_and_comments(lexer, &scanned_comment, true) &&
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

static int32_t hex_digit_value(int32_t character) {
    if (character >= '0' && character <= '9') return character - '0';
    if (character >= 'a' && character <= 'f') return character - 'a' + 10;
    if (character >= 'A' && character <= 'F') return character - 'A' + 10;
    return -1;
}

static int32_t scan_identifier_character(TSLexer *lexer) {
    int32_t character = lexer->lookahead;
    advance(lexer);
    if (character != '\\') return character;
    if (lexer->lookahead != 'u') return -1;
    advance(lexer);
    bool braced = lexer->lookahead == '{';
    if (braced) advance(lexer);
    uint32_t value = 0;
    unsigned digits = 0;
    while (braced ? lexer->lookahead != '}' : digits < 4) {
        int32_t digit = hex_digit_value(lexer->lookahead);
        if (digit < 0 || value > 0x10FFFF / 16) return -1;
        value = value * 16 + (uint32_t)digit;
        if (value > 0x10FFFF) return -1;
        digits++;
        advance(lexer);
    }
    if (digits == 0) return -1;
    if (braced) advance(lexer);
    return (int32_t)value;
}

static bool scan_global_declaration_start(TSLexer *lexer) {
    while (is_whitespace(lexer->lookahead)) {
        skip(lexer);
    }
    const char *word = "global";
    for (; *word; word++) {
        if (scan_identifier_character(lexer) != *word) {
            return false;
        }
    }
    if (is_identifier_part(lexer->lookahead)) {
        return false;
    }
    lexer->mark_end(lexer);
    bool scanned_comment = false;
    if (!scan_type_whitespace_and_comments(lexer, &scanned_comment, false)) {
        return false;
    }
    if (lexer->lookahead == '{') {
        lexer->result_symbol = GLOBAL_DECLARATION_START;
        return true;
    }
    if (!is_identifier_part(lexer->lookahead) || is_ascii_digit(lexer->lookahead)) {
        return false;
    }
    char next_word[TS_GLOBAL_KEYWORD_MAX_LENGTH + 1] = {0};
    unsigned length = 0;
    while (is_identifier_part(lexer->lookahead)) {
        int32_t character = scan_identifier_character(lexer);
        if (!is_identifier_part(character) || character == '\\' || (length == 0 && is_ascii_digit(character))) {
            return false;
        }
        if (character > 0x7F || length == sizeof(next_word) - 1) {
            lexer->result_symbol = GLOBAL_DECLARATION_START;
            return true;
        }
        next_word[length++] = (char)character;
    }
    // TypeScript starts a global augmentation before a brace, an Identifier token, or export,
    // including across line breaks; contextual keyword tokens do not satisfy that lookahead.
    for (unsigned i = 0; i < sizeof(TS_GLOBAL_KEYWORDS) / sizeof(TS_GLOBAL_KEYWORDS[0]); i++) {
        if (strcmp(next_word, TS_GLOBAL_KEYWORDS[i]) == 0) {
            return false;
        }
    }
    lexer->result_symbol = GLOBAL_DECLARATION_START;
    return true;
}

static bool scan_global_declaration_end(TSLexer *lexer) {
    lexer->mark_end(lexer);
    bool saw_line_break = false;
    for (;;) {
        while (is_whitespace(lexer->lookahead)) {
            saw_line_break |= is_line_terminator(lexer->lookahead);
            skip(lexer);
        }
        if (lexer->lookahead != '/') {
            break;
        }
        bool scanned_comment = false;
        CommentResult result = skip_comment(lexer, &scanned_comment, true);
        if (result == NO_COMMENT) {
            return false;
        }
        saw_line_break |= result == COMMENT_WITH_LINE_TERMINATOR;
    }
    if (!saw_line_break || lexer->lookahead == '{') {
        return false;
    }
    lexer->result_symbol = GLOBAL_DECLARATION_END;
    return true;
}

static bool scan_expression_end(TSLexer *lexer, bool after_postfix, bool *statement_end, const bool *valid_symbols) {
    lexer->mark_end(lexer);
    lexer->result_symbol = after_postfix ? POSTFIX_UPDATE_END : AWAIT_OPERAND_END;
    bool saw_newline = false;
    bool scanned_comment = false;
    for (;;) {
        while (is_whitespace(lexer->lookahead)) {
            saw_newline |= is_line_terminator(lexer->lookahead);
            skip(lexer);
        }
        if (lexer->lookahead != '/') {
            break;
        }
        skip(lexer);
        if (lexer->lookahead == '/') {
            scanned_comment = true;
            while (!lexer->eof(lexer) && !is_line_terminator(lexer->lookahead)) {
                skip(lexer);
            }
        } else if (lexer->lookahead == '*') {
            scanned_comment = true;
            skip(lexer);
            while (!lexer->eof(lexer)) {
                saw_newline |= is_line_terminator(lexer->lookahead);
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
            return valid_symbols[AWAIT_OPERAND_END] || after_postfix;
        }
    }
    if (valid_symbols[RESOURCE_BINDING_START] || valid_symbols[RESOURCE_BINDING_CONTINUATION] ||
        valid_symbols[PLAIN_RESOURCE_FOR_OF_CONTEXT]) {
        bool first_binding = valid_symbols[RESOURCE_BINDING_START] || valid_symbols[PLAIN_RESOURCE_FOR_OF_CONTEXT];
        if (is_identifier_part(lexer->lookahead) && !is_ascii_digit(lexer->lookahead)) {
            bool infix_operator = false;
            bool binding = scan_resource_binding(lexer, valid_symbols[PLAIN_RESOURCE_FOR_OF_CONTEXT], saw_newline && first_binding, &infix_operator);
            if (binding) {
                lexer->result_symbol = valid_symbols[RESOURCE_BINDING_START] ? RESOURCE_BINDING_START : RESOURCE_BINDING_CONTINUATION;
                return true;
            }
            return (infix_operator || (saw_newline && first_binding)) && valid_symbols[AWAIT_OPERAND_END];
        }
        if (!valid_symbols[AWAIT_OPERAND_END]) {
            return !scanned_comment && valid_symbols[TERNARY_QMARK] && lexer->lookahead == '?' && scan_ternary_qmark(lexer);
        }
    }
    if (after_postfix && lexer->lookahead != '(' && lexer->lookahead != '[' && lexer->lookahead != '`') {
        if (lexer->lookahead == '.') {
            skip(lexer);
            return saw_newline && is_ascii_digit(lexer->lookahead);
        }
        return true;
    }
    switch (lexer->lookahead) {
        case '(':
        case '[':
        case '`':
            *statement_end = after_postfix && saw_newline;
            return *statement_end;
        case '?':
            skip(lexer);
            return lexer->lookahead != '.';
        case 'i': {
            char word[16] = {0};
            bool ascii_word = scan_identifier(lexer, word, sizeof(word), true);
            return saw_newline || (ascii_word && (strcmp(word, "in") == 0 || strcmp(word, "instanceof") == 0));
        }
        case '!':
            skip(lexer);
            return after_postfix || saw_newline || lexer->lookahead == '=';
        case '<':
            return after_postfix;
        case '=':
        case '*':
        case '%':
        case '>':
        case '^':
        case '|':
        case '&':
            return true;
        case '.':
            skip(lexer);
            return is_ascii_digit(lexer->lookahead);
        case '+':
        case '-': {
            int32_t sign = lexer->lookahead;
            skip(lexer);
            return lexer->lookahead != sign || saw_newline;
        }
        case ';':
        case ',':
        case ':':
        case ')':
        case ']':
        case '}':
            return true;
        default:
            return lexer->eof(lexer) || saw_newline;
    }
}

static bool scan_resource_binding(TSLexer *lexer, bool plain_for_of, bool after_line_break, bool *infix_operator) {
    char word[16] = {0};
    unsigned length = 0;
    bool ascii_word = true;
    bool escaped = false;
    while (is_identifier_part(lexer->lookahead)) {
        uint32_t character = (uint32_t)lexer->lookahead;
        if (character == '\\') {
            escaped = true;
            advance(lexer);
            if (lexer->lookahead != 'u') return false;
            advance(lexer);
            bool braced = lexer->lookahead == '{';
            if (braced) advance(lexer);
            character = 0;
            unsigned digits = 0;
            while (is_hex_digit(lexer->lookahead) && (braced || digits < 4)) {
                unsigned digit = is_ascii_digit(lexer->lookahead) ? lexer->lookahead - '0' :
                    (lexer->lookahead >= 'a' ? lexer->lookahead - 'a' : lexer->lookahead - 'A') + 10;
                character = character > 0x7F ? 0x80 : character * 16 + digit;
                advance(lexer);
                digits++;
            }
            if (braced) {
                if (digits == 0 || lexer->lookahead != '}') return false;
                advance(lexer);
            } else if (digits != 4) {
                return false;
            }
        } else {
            advance(lexer);
        }
        if (character > 0x7F || length == sizeof(word) - 1) {
            ascii_word = false;
        } else {
            word[length++] = (char)character;
        }
    }
    if (infix_operator) {
        *infix_operator = !escaped && ascii_word && (strcmp(word, "in") == 0 || strcmp(word, "instanceof") == 0);
    }
    if (ascii_word && plain_for_of && strcmp(word, "of") == 0) {
        bool scanned_content = false;
        return scan_whitespace_and_comments(lexer, &scanned_content, true, false) != REJECT &&
            (lexer->lookahead == '=' || lexer->lookahead == ':');
    }
    return !after_line_break && (!ascii_word || (strcmp(word, "enum") != 0 && !is_reserved_word(word)));
}

static bool scan_await_yield_identifier(TSLexer *lexer) {
    bool scanned_content = false;
    if (scan_whitespace_and_comments(lexer, &scanned_content, true, true) == REJECT || scanned_content) {
        return false;
    }
    for (const char *word = "yield"; *word; word++) {
        if (lexer->lookahead != *word) {
            return false;
        }
        advance(lexer);
    }
    if (is_identifier_part(lexer->lookahead)) {
        return false;
    }
    lexer->mark_end(lexer);
    lexer->result_symbol = AWAIT_YIELD_IDENTIFIER;
    return true;
}

static bool scan_await_keyword(TSLexer *lexer) {
    bool scanned_content = false;
    if (scan_whitespace_and_comments(lexer, &scanned_content, true, true) == REJECT || scanned_content) {
        return false;
    }
    for (const char *word = "await"; *word; word++) {
        if (lexer->lookahead != *word) {
            return false;
        }
        advance(lexer);
    }
    if (is_identifier_part(lexer->lookahead)) {
        return false;
    }
    lexer->mark_end(lexer);
    // Probing past mark_end adds lookahead dependencies so operand edits invalidate restored keyword/identifier roles.
    // Advancing without skipping after mark_end preserves the consuming keyword's start across probed comments.
    for (unsigned words = 0; words <= 2; words++) {
        if (scan_whitespace_and_comments(lexer, &scanned_content, true, false) == REJECT ||
            words == 2 || !is_identifier_part(lexer->lookahead)) {
            break;
        }
        char word[16] = {0};
        scan_identifier(lexer, word, sizeof(word), false);
    }
    lexer->result_symbol = AWAIT_KEYWORD;
    return true;
}

static bool scan_generic_function_type(TSLexer *lexer);
static bool scan_annotated_type_colons(TSLexer *lexer, bool allow_expression);
enum TypeGroupEnd {
    TYPE_GROUP_END_MASK = 0xff,
    TYPE_PARAMETER_GROUP_END = '>' | (1 << 8),
    FUNCTION_PARAMETER_GROUP_END = ')' | (2 << 8),
    METHOD_TYPE_PARAMETER_GROUP_END = '>' | (3 << 8),
    METHOD_PARAMETER_GROUP_END = ')' | (4 << 8),
    OBJECT_PROPERTY_GROUP_END = '}' | (5 << 8),
    COMPUTED_PROPERTY_GROUP_END = ']' | (6 << 8),
    PROPERTY_NAME_GROUP = 7 << 8,
    TYPE_SUBSTITUTION_GROUP_END = '}' | (8 << 8),
    TYPE_OPERAND_GROUP_END = ')' | (9 << 8),
    UNTYPED_PARAMETER_GROUP_END = ')' | (10 << 8),
    TYPE_GROUP_ROLE_MASK = 0xffff,
    TYPE_EXPRESSION_GROUP = 1 << 16,
    TYPE_EXPRESSION_OPERAND = 1 << 17,
    TYPE_EXPRESSION_PROPERTY = 1 << 18,
    TYPE_EXPRESSION_EMPTY_GROUP = 1 << 19,
    TYPE_EXPRESSION_BODY = 1 << 20,
    TYPE_EXPRESSION_FUNCTION = 1 << 21,
    TYPE_EXPRESSION_METHOD_BODY = 1 << 22,
    TYPE_EXPRESSION_TYPE = 1 << 23,
    TYPE_GROUP_PARAMETER = 1 << 24,
};
static bool scan_type_group(TSLexer *lexer, int32_t close, bool type_operands, bool html_comments);
static bool scan_type_html_comment_tail(TSLexer *lexer, int32_t opening);
static bool scan_type_identifier_operand(TSLexer *lexer);

static bool scan_type_reference_arguments_start(TSLexer *lexer, const bool *valid_symbols, bool heritage) {
    bool unqualified = valid_symbols[UNQUALIFIED_TYPE_REFERENCE_ARGUMENTS_START];
    bool allow_type_arguments = unqualified || valid_symbols[TYPE_REFERENCE_ARGUMENTS_START];
    while (is_whitespace(lexer->lookahead)) skip(lexer);
    lexer->mark_end(lexer);
    bool comment = false;
    bool private_name = lexer->lookahead == '#';
    if (private_name) advance(lexer);
    if (!is_identifier_part(lexer->lookahead) || is_ascii_digit(lexer->lookahead)) return false;
    char word[16] = {0};
    bool ascii_word = scan_identifier(lexer, word, sizeof(word), false);
    if (unqualified && (valid_symbols[PREDEFINED_PARAMETER_NAME] || valid_symbols[PREDEFINED_ANNOTATED_NAME]) && !private_name && ascii_word &&
        (strcmp(word, "unknown") == 0 || strcmp(word, "never") == 0 || strcmp(word, "unique") == 0)) {
        lexer->mark_end(lexer);
        if (!scan_default_trivia(lexer, true, true)) return false;
        bool optional_parameter = lexer->lookahead == '?';
        if (optional_parameter) {
            advance(lexer);
            if (!scan_default_trivia(lexer, true, true)) return false;
        }
        bool untyped_parameter = lexer->lookahead == ')' || lexer->lookahead == ',';
        if (!untyped_parameter && lexer->lookahead != ':') return false;
        if (!untyped_parameter && (optional_parameter || valid_symbols[PREDEFINED_ANNOTATED_NAME])) {
            advance(lexer);
            if (!scan_default_trivia(lexer, true, false)) return false;
            while (lexer->lookahead == '?') {
                advance(lexer);
                if (!scan_default_trivia(lexer, true, false)) return false;
            }
            if (lexer->eof(lexer)) return false;
            switch (lexer->lookahead) {
                case ')':
                case ']':
                case '}':
                case ',':
                case ';':
                case '=':
                case ':':
                case '>':
                    return false;
                default:
                    break;
            }
            if (!scan_annotated_type_colons(lexer, false)) return false;
        }
        if (!optional_parameter && !untyped_parameter && valid_symbols[PREDEFINED_ANNOTATED_NAME]) {
            lexer->result_symbol = PREDEFINED_ANNOTATED_NAME;
        } else if (valid_symbols[PREDEFINED_PARAMETER_NAME]) {
            lexer->result_symbol = PREDEFINED_PARAMETER_NAME;
        } else {
            return false;
        }
        if (!scan_type_group(lexer, untyped_parameter ? UNTYPED_PARAMETER_GROUP_END : ')', false, true) || !scan_default_trivia(lexer, true, false) || lexer->lookahead != '=') return false;
        advance(lexer);
        if (lexer->lookahead != '>') return false;
        advance(lexer);
        if (optional_parameter || untyped_parameter) {
            if (!scan_default_trivia(lexer, true, false) || lexer->eof(lexer)) return false;
            if (untyped_parameter) {
                while (lexer->lookahead == '|' || lexer->lookahead == '&' || lexer->lookahead == '?') {
                    advance(lexer);
                    if (!scan_default_trivia(lexer, true, false) || lexer->eof(lexer)) return false;
                }
            }
            switch (lexer->lookahead) {
                case ')':
                case ']':
                case '}':
                case ',':
                case ';':
                case ':':
                case '=':
                case '>':
                    return false;
                default:
                    break;
            }
        }
        bool return_identifier = false;
        if (untyped_parameter) {
            int32_t operand = lexer->lookahead;
            if (operand == '%' || operand == '^' || operand == '!' || operand == '~' || operand == '@' || operand == '#') return false;
            if (operand == '\\') {
                if (!scan_type_identifier_operand(lexer)) return false;
                return_identifier = true;
            } else if (operand == '.' || operand == '-' || operand == '+') {
                advance(lexer);
                if (operand != '.') {
                    if (!scan_default_trivia(lexer, true, false)) return false;
                    if (lexer->lookahead == '.') advance(lexer);
                }
                if (!is_ascii_digit(lexer->lookahead)) return false;
            }
        }
        if (!scan_annotated_type_colons(lexer, !untyped_parameter || return_identifier)) return false;
        return true;
    }
    if (!allow_type_arguments && !valid_symbols[ABSTRACT_CONSTRUCTOR_PREFIX]) return false;
    if (unqualified && ascii_word) {
        static const char *keywords[] = {"new", "typeof", "keyof", "readonly", "unique", "infer", "any", "number", "boolean", "string", "symbol", "void", "unknown", "never", "object", "this", "import", "true", "false", "null", "undefined"};
        for (unsigned i = 0; i < sizeof(keywords) / sizeof(keywords[0]); i++) {
            if (strcmp(word, keywords[i]) == 0) return false;
        }
    }
    bool abstract_prefix = valid_symbols[ABSTRACT_CONSTRUCTOR_PREFIX] && ascii_word && strcmp(word, "abstract") == 0;
    bool line_break = false;
    for (;;) {
        while (is_whitespace(lexer->lookahead)) {
            if (is_line_terminator(lexer->lookahead)) {
                line_break = true;
                if (!heritage && !abstract_prefix) return false;
            }
            advance(lexer);
        }
        if (lexer->lookahead != '/') break;
        CommentResult result = skip_comment(lexer, &comment, true);
        if (result == COMMENT_WITH_LINE_TERMINATOR) line_break = true;
        if (result != COMMENT && !((heritage || abstract_prefix) && result == COMMENT_WITH_LINE_TERMINATOR)) return false;
    }
    if (abstract_prefix && lexer->lookahead == 'n') {
        char next[4] = {0};
        if (!scan_identifier(lexer, next, sizeof(next), false) || strcmp(next, "new") != 0) return false;
        lexer->result_symbol = ABSTRACT_CONSTRUCTOR_PREFIX;
        return true;
    }
    if (!allow_type_arguments || (line_break && !heritage) || lexer->lookahead != '<') return false;
    advance(lexer);
    if (lexer->lookahead == '=') return false;
    if (lexer->lookahead == '<' && !scan_generic_function_type(lexer)) return false;
    lexer->result_symbol = unqualified ? UNQUALIFIED_TYPE_REFERENCE_ARGUMENTS_START : TYPE_REFERENCE_ARGUMENTS_START;
    return true;
}

static bool scan_generic_function_type(TSLexer *lexer) {
    bool comment = false;
    advance(lexer);
    if (!scan_type_group(lexer, '>', false, false) || !scan_type_whitespace_and_comments(lexer, &comment, false) || lexer->lookahead != '(') return false;
    advance(lexer);
    if (!scan_type_group(lexer, ')', false, false) || !scan_type_whitespace_and_comments(lexer, &comment, false) || lexer->lookahead != '=') return false;
    advance(lexer);
    return lexer->lookahead == '>';
}

static bool scan_type_group(TSLexer *lexer, int32_t close, bool type_operands, bool html_comments) {
    unsigned size = 1, capacity = 32;
    int32_t *stack = ts_malloc(capacity * sizeof(int32_t));
    if (!stack) return false;
    stack[0] = type_operands && close == '}' ? OBJECT_PROPERTY_GROUP_END : type_operands && close == ')' ? TYPE_OPERAND_GROUP_END | TYPE_GROUP_PARAMETER : close;
    bool result = false;
    bool first_operand = close != UNTYPED_PARAMETER_GROUP_END, operand_pending = false, query_operand = false, parameter_position = close != TYPE_SUBSTITUTION_GROUP_END, member_line_break = false;
    if (type_operands && close == '}' && lexer->lookahead == '|') advance(lexer);
    while (!lexer->eof(lexer)) {
        int32_t c = lexer->lookahead, context = stack[size - 1];
        if (context & TYPE_EXPRESSION_TYPE) {
            if ((context & TYPE_EXPRESSION_METHOD_BODY) && !first_operand && c == '{') {
                stack[size - 1] &= ~(TYPE_EXPRESSION_TYPE | TYPE_EXPRESSION_METHOD_BODY);
                stack[size - 1] |= TYPE_EXPRESSION_BODY;
            } else if (((context & TYPE_GROUP_ROLE_MASK) == METHOD_PARAMETER_GROUP_END || (context & TYPE_GROUP_ROLE_MASK) == FUNCTION_PARAMETER_GROUP_END) && c == ',') {
                stack[size - 1] &= ~TYPE_EXPRESSION_TYPE;
            }
            context = stack[size - 1];
        }
        int32_t frame = context & TYPE_EXPRESSION_TYPE ? context & TYPE_GROUP_ROLE_MASK : context & ~TYPE_GROUP_PARAMETER;
        int32_t end = frame & TYPE_GROUP_END_MASK, push = 0;
        if (close == UNTYPED_PARAMETER_GROUP_END && size == 1 && first_operand && c == ',') break;
        bool check_type_operands = type_operands && !(frame & TYPE_EXPRESSION_GROUP);
        bool check_expression_operands = type_operands && (frame & TYPE_EXPRESSION_GROUP);
        if (end == '\'' || end == '"' || end == '`') {
            advance(lexer);
            if (c == end) {
                size--;
                if ((frame & ~TYPE_GROUP_END_MASK) == PROPERTY_NAME_GROUP) parameter_position = true;
                continue;
            }
            if (c == '\\' && !lexer->eof(lexer)) advance(lexer);
            else if (end == '`' && c == '$' && lexer->lookahead == '{') {
                advance(lexer);
                push = check_type_operands || check_expression_operands ? TYPE_SUBSTITUTION_GROUP_END : '}';
                if (check_type_operands) {
                    first_operand = true;
                    operand_pending = false;
                    query_operand = false;
                    parameter_position = false;
                }
            }
        } else {
            if (member_line_break && !is_whitespace(c) && c != '/') {
                if (is_identifier_part(c) || c == '\'' || c == '"' || c == '<' || c == '(' || c == '[') {
                    first_operand = true;
                    parameter_position = true;
                }
                member_line_break = false;
            }
            if (((check_type_operands && (operand_pending || (first_operand && frame == COMPUTED_PROPERTY_GROUP_END && !parameter_position))) || (check_expression_operands && (frame & TYPE_EXPRESSION_OPERAND))) && c == '\\') {
                if (!scan_type_identifier_operand(lexer)) break;
                stack[size - 1] &= ~(TYPE_EXPRESSION_OPERAND | TYPE_EXPRESSION_PROPERTY | TYPE_EXPRESSION_EMPTY_GROUP | TYPE_EXPRESSION_BODY);
                operand_pending = false;
                first_operand = false;
                query_operand = false;
                continue;
            }
            if (check_type_operands && is_identifier_part(c)) {
                char word[16] = {0};
                bool ascii_word = scan_identifier(lexer, word, sizeof(word), false);
                if (query_operand && ascii_word && strcmp(word, "typeof") == 0) break;
                if (frame == COMPUTED_PROPERTY_GROUP_END && !parameter_position && operand_pending && ascii_word && strcmp(word, "as") == 0) {
                    if (!scan_default_trivia(lexer, true, false)) break;
                    if (is_identifier_part(lexer->lookahead)) {
                        char next[16] = {0};
                        if (!scan_identifier(lexer, next, sizeof(next), false) || (strcmp(next, "extends") != 0 && strcmp(next, "as") != 0)) break;
                        operand_pending = false;
                        query_operand = false;
                        first_operand = true;
                        continue;
                    }
                    if (lexer->lookahead != ']' && lexer->lookahead != '[' && lexer->lookahead != '<' && lexer->lookahead != '.' && lexer->lookahead != '|' && lexer->lookahead != '&' && lexer->lookahead != '?') break;
                }
                bool computed_key = frame == COMPUTED_PROPERTY_GROUP_END && parameter_position;
                if (computed_key && !first_operand && !(ascii_word && strcmp(word, "in") == 0)) {
                    stack[size - 1] |= TYPE_EXPRESSION_GROUP;
                    if (ascii_word && strcmp(word, "instanceof") == 0) stack[size - 1] |= TYPE_EXPRESSION_OPERAND;
                }
                bool mapped_operand = frame == COMPUTED_PROPERTY_GROUP_END && ascii_word &&
                    ((strcmp(word, "in") == 0 && parameter_position && (!first_operand || operand_pending)) ||
                     (strcmp(word, "as") == 0 && !parameter_position && !first_operand && !operand_pending));
                bool prefix = !computed_key && first_operand && ascii_word && (strcmp(word, "typeof") == 0 || strcmp(word, "keyof") == 0 || strcmp(word, "readonly") == 0 || strcmp(word, "infer") == 0);
                operand_pending = prefix;
                query_operand = prefix && strcmp(word, "typeof") == 0;
                bool extends_operand = !computed_key && ascii_word && strcmp(word, "extends") == 0;
                first_operand = (prefix && !query_operand && strcmp(word, "infer") != 0) || extends_operand || mapped_operand || (!computed_key && first_operand && ascii_word && (strcmp(word, "new") == 0 || strcmp(word, "abstract") == 0));
                if (extends_operand || mapped_operand) {
                    parameter_position = false;
                    if (frame == TYPE_OPERAND_GROUP_END) stack[size - 1] &= ~TYPE_GROUP_PARAMETER;
                }
                continue;
            }
            if (check_expression_operands && is_identifier_part(c)) {
                char word[16] = {0};
                bool ascii_word = scan_identifier(lexer, word, sizeof(word), false);
                bool expression_prefix = !(frame & TYPE_EXPRESSION_PROPERTY) && ascii_word &&
                    (strcmp(word, "in") == 0 || strcmp(word, "instanceof") == 0 || strcmp(word, "typeof") == 0 || strcmp(word, "new") == 0 || strcmp(word, "void") == 0 || strcmp(word, "delete") == 0);
                bool member_name = (frame & TYPE_GROUP_ROLE_MASK) == OBJECT_PROPERTY_GROUP_END && (frame & TYPE_EXPRESSION_PROPERTY);
                stack[size - 1] &= ~(TYPE_EXPRESSION_OPERAND | TYPE_EXPRESSION_EMPTY_GROUP | TYPE_EXPRESSION_BODY);
                if (!member_name) stack[size - 1] &= ~TYPE_EXPRESSION_PROPERTY;
                if (!(frame & TYPE_EXPRESSION_PROPERTY) && ascii_word && strcmp(word, "function") == 0) stack[size - 1] |= TYPE_EXPRESSION_FUNCTION;
                if (expression_prefix) stack[size - 1] |= TYPE_EXPRESSION_OPERAND;
                first_operand = expression_prefix;
                operand_pending = false;
                query_operand = false;
                continue;
            }
            if (c == '/') {
                bool comment = false;
                CommentResult comment_result = skip_comment(lexer, &comment, false);
                if (comment_result == NO_COMMENT) break;
                if (comment_result == COMMENT_WITH_LINE_TERMINATOR && frame == OBJECT_PROPERTY_GROUP_END && !first_operand && !operand_pending) {
                    member_line_break = true;
                }
                continue;
            }
            if (is_line_terminator(c) && frame == OBJECT_PROPERTY_GROUP_END && !first_operand && !operand_pending) {
                member_line_break = true;
            }
            bool binding_frame = parameter_position && (frame == OBJECT_PROPERTY_GROUP_END || frame == COMPUTED_PROPERTY_GROUP_END || frame == TYPE_PARAMETER_GROUP_END || frame == METHOD_TYPE_PARAMETER_GROUP_END || frame == FUNCTION_PARAMETER_GROUP_END || frame == METHOD_PARAMETER_GROUP_END);
            bool computed_expression = check_type_operands && frame == COMPUTED_PROPERTY_GROUP_END && parameter_position;
            bool expression_operand = (frame & TYPE_EXPRESSION_OPERAND) != 0;
            bool parameter_default = parameter_position && end == ')' && c == '=';
            bool consumed_operator = check_type_operands && frame == OBJECT_PROPERTY_GROUP_END && c == '|';
            if (consumed_operator) {
                advance(lexer);
                if (lexer->lookahead == '}') {
                    c = '}';
                    consumed_operator = false;
                }
            }
            if (check_type_operands && frame == OBJECT_PROPERTY_GROUP_END && first_operand && !parameter_position && (c == '}' || c == ',' || c == ';')) break;
            if (check_type_operands && operand_pending && (c == '.' || c == '-' || c == '+') && !(parameter_position && frame == COMPUTED_PROPERTY_GROUP_END)) {
                if (query_operand || !first_operand) break;
                advance(lexer);
                if (c != '.') {
                    if (!scan_default_trivia(lexer, true, false)) break;
                    if (lexer->lookahead == '.') advance(lexer);
                }
                if (!is_ascii_digit(lexer->lookahead)) break;
                operand_pending = false;
                first_operand = false;
                parameter_position = false;
                continue;
            }
            if (check_type_operands && operand_pending && !binding_frame && (c == ':' || c == '?' || c == ',' || c == ';')) {
                if (!parameter_position || (frame == TYPE_OPERAND_GROUP_END && !(context & TYPE_GROUP_PARAMETER)) || (end != ')' && end != ']') || (c != ':' && c != '?')) break;
                advance(lexer);
                if (!scan_default_trivia(lexer, true, false)) break;
                if (c == '?') {
                    if (lexer->lookahead != ':') break;
                    advance(lexer);
                    if (!scan_default_trivia(lexer, true, false)) break;
                }
                int32_t operand = lexer->lookahead;
                if (lexer->eof(lexer) || operand == ')' || operand == ']' || operand == '}' || operand == ',' || operand == ';' || operand == ':' || operand == '=' || operand == '>') break;
                if (frame == TYPE_OPERAND_GROUP_END) stack[size - 1] = FUNCTION_PARAMETER_GROUP_END;
                first_operand = true;
                operand_pending = false;
                query_operand = false;
                parameter_position = false;
                continue;
            }
            if (check_type_operands && operand_pending && (c == '%' || c == '^' || c == '!' || c == '~' || c == '@' || c == '#' || (c == '=' && !binding_frame && !parameter_default) || (c == '>' && !binding_frame) || c == '|' || c == '&')) break;
            if (check_type_operands && operand_pending && parameter_default && !binding_frame) stack[size - 1] = FUNCTION_PARAMETER_GROUP_END;
            if (check_type_operands && (context & TYPE_GROUP_PARAMETER) && c == ':' && frame == TYPE_OPERAND_GROUP_END) stack[size - 1] = FUNCTION_PARAMETER_GROUP_END;
            bool expression_annotation = check_expression_operands && c == ':' &&
                ((end == ')' && (first_operand || (context & TYPE_GROUP_PARAMETER))) || (context & TYPE_EXPRESSION_METHOD_BODY));
            if (expression_annotation) {
                stack[size - 1] &= ~TYPE_EXPRESSION_OPERAND;
                stack[size - 1] |= TYPE_EXPRESSION_TYPE;
            }
            if (!consumed_operator) advance(lexer);
            if (check_type_operands && frame == TYPE_OPERAND_GROUP_END && (c == '|' || c == '&' || c == '=' || c == '<' || (c == '[' && !first_operand))) stack[size - 1] &= ~TYPE_GROUP_PARAMETER;
            if (check_type_operands && frame == TYPE_OPERAND_GROUP_END && parameter_position && first_operand && c == '.' && lexer->lookahead == '.') {
                advance(lexer);
                if (lexer->lookahead != '.') break;
                advance(lexer);
                continue;
            }
            if (c == '=' && lexer->lookahead != '>') stack[size - 1] &= ~TYPE_EXPRESSION_TYPE;
            if (check_expression_operands && end == ')') {
                if (c == '=' || c == '?' || c == ':') stack[size - 1] &= ~TYPE_GROUP_PARAMETER;
                else if (c == ',') stack[size - 1] |= TYPE_GROUP_PARAMETER;
            }
            bool expression_postfix = (computed_expression || check_expression_operands) && (c == '+' || c == '-') && lexer->lookahead == c && !expression_operand && !first_operand;
            if (html_comments && (c == '<' || c == '-') && scan_type_html_comment_tail(lexer, c)) break;
            if (c == end) {
                bool expression_arrow = (context & TYPE_EXPRESSION_GROUP) && ((frame & TYPE_GROUP_ROLE_MASK) == FUNCTION_PARAMETER_GROUP_END || (check_expression_operands && expression_operand && (frame & TYPE_EXPRESSION_EMPTY_GROUP) && end == ')'));
                if ((context & TYPE_EXPRESSION_METHOD_BODY) || (check_expression_operands && expression_operand && !expression_arrow)) break;
                if (check_type_operands && frame == COMPUTED_PROPERTY_GROUP_END && !parameter_position && first_operand) break;
                if (check_type_operands && (frame == TYPE_PARAMETER_GROUP_END || frame == METHOD_TYPE_PARAMETER_GROUP_END)) {
                    if (!scan_default_trivia(lexer, true, false) || lexer->lookahead != '(') break;
                    advance(lexer);
                    stack[size - 1] = frame == METHOD_TYPE_PARAMETER_GROUP_END ? METHOD_PARAMETER_GROUP_END : FUNCTION_PARAMETER_GROUP_END;
                    operand_pending = false;
                    first_operand = true;
                    query_operand = false;
                    parameter_position = true;
                    continue;
                }
                if (check_type_operands && operand_pending && parameter_position && (frame == OBJECT_PROPERTY_GROUP_END || frame == COMPUTED_PROPERTY_GROUP_END || frame == METHOD_PARAMETER_GROUP_END)) operand_pending = false;
                if (frame == METHOD_PARAMETER_GROUP_END && operand_pending) break;
                if (expression_arrow && end == ')') {
                    if (!scan_default_trivia(lexer, true, false)) break;
                    if (lexer->lookahead == ':') expression_arrow = false;
                }
                bool return_identifier = false;
                bool arrow_header = expression_arrow || frame == FUNCTION_PARAMETER_GROUP_END || (check_type_operands && (operand_pending || (frame == TYPE_OPERAND_GROUP_END && first_operand)));
                if (arrow_header) {
                    if (end != ')' || (operand_pending && !parameter_position)) break;
                    if (!scan_default_trivia(lexer, true, false) || lexer->lookahead != '=') break;
                    advance(lexer);
                    if (lexer->lookahead != '>') break;
                    advance(lexer);
                    bool return_operand = scan_default_trivia(lexer, true, false);
                    while (!expression_arrow && return_operand && (lexer->lookahead == '|' || lexer->lookahead == '&')) {
                        advance(lexer);
                        return_operand = scan_default_trivia(lexer, true, false);
                    }
                    if (!return_operand || lexer->eof(lexer)) break;
                    int32_t operand = lexer->lookahead;
                    if (expression_arrow) {
                        if (operand == ')' || operand == ']' || operand == '}' || operand == ',' || operand == ';' || operand == ':' || operand == '=' || operand == '>' || operand == '|' || operand == '&' || operand == '?') break;
                    } else if (operand == '\\') {
                        if (!scan_type_identifier_operand(lexer)) break;
                        return_identifier = true;
                    } else if (operand == '.' || operand == '-' || operand == '+') {
                        advance(lexer);
                        if (operand != '.') {
                            if (!scan_default_trivia(lexer, true, false)) break;
                            if (lexer->lookahead == '.') advance(lexer);
                        }
                        if (!is_ascii_digit(lexer->lookahead)) break;
                    } else if (operand == '%' || operand == '^' || operand == '!' || operand == '~' || operand == '@' || operand == '#' || operand == ')' || operand == ']' || operand == '}' || operand == ',' || operand == ';' || operand == ':' || operand == '=' || operand == '>' || operand == '|' || operand == '&' || operand == '?') break;
                }
                operand_pending = arrow_header && !return_identifier;
                first_operand = operand_pending;
                query_operand = false;
                if (arrow_header) parameter_position = false;
                if (--size == 0) { result = true; break; }
                if (expression_arrow) stack[size - 1] |= TYPE_EXPRESSION_OPERAND | TYPE_EXPRESSION_BODY;
                if ((context & TYPE_EXPRESSION_GROUP) && (frame & TYPE_GROUP_ROLE_MASK) == METHOD_PARAMETER_GROUP_END) stack[size - 1] |= TYPE_EXPRESSION_OPERAND | TYPE_EXPRESSION_METHOD_BODY;
                continue;
            }
            if (c == '\'' || c == '"' || c == '`') {
                push = c | (check_type_operands && frame == OBJECT_PROPERTY_GROUP_END && parameter_position ? PROPERTY_NAME_GROUP : 0);
                if (c == '`' && frame == COMPUTED_PROPERTY_GROUP_END && parameter_position) push |= TYPE_EXPRESSION_GROUP;
            }
            else if (c == '=') {
                if (lexer->lookahead == '>') {
                    advance(lexer);
                    if (context & TYPE_EXPRESSION_TYPE) {
                        stack[size - 1] &= ~TYPE_EXPRESSION_TYPE;
                        stack[size - 1] |= TYPE_EXPRESSION_OPERAND | TYPE_EXPRESSION_BODY;
                    }
                    if (check_expression_operands || computed_expression) stack[size - 1] |= TYPE_EXPRESSION_BODY;
                }
            }
            else if (c == '<') push = check_type_operands && frame == OBJECT_PROPERTY_GROUP_END && parameter_position ? METHOD_TYPE_PARAMETER_GROUP_END : check_type_operands && first_operand ? TYPE_PARAMETER_GROUP_END : '>';
            else if (c == '(') push = check_type_operands && frame == OBJECT_PROPERTY_GROUP_END && parameter_position ? METHOD_PARAMETER_GROUP_END : check_type_operands && !binding_frame && (operand_pending || first_operand) ? TYPE_OPERAND_GROUP_END : ')';
            else if (c == '[') push = check_type_operands && frame == OBJECT_PROPERTY_GROUP_END && parameter_position ? COMPUTED_PROPERTY_GROUP_END : ']';
            else if (c == '{') {
                push = check_type_operands ? OBJECT_PROPERTY_GROUP_END : '}';
                if (check_type_operands && !computed_expression && lexer->lookahead == '|') advance(lexer);
            }
            else if (c == ')' || c == ']' || c == '}' || (c == ';' && end == '>')) break;
            if (computed_expression && !is_whitespace(c) && !(c == ':' && !first_operand)) stack[size - 1] |= TYPE_EXPRESSION_GROUP;
            if (push && computed_expression) push |= TYPE_EXPRESSION_GROUP;
            if ((computed_expression || check_expression_operands) && !is_whitespace(c)) {
                bool member_name = (frame & TYPE_GROUP_ROLE_MASK) == OBJECT_PROPERTY_GROUP_END && (frame & TYPE_EXPRESSION_PROPERTY);
                bool method_body = c == '{' && (frame & TYPE_EXPRESSION_METHOD_BODY) && !first_operand;
                if (c == '{' && !(frame & TYPE_EXPRESSION_BODY) && !method_body) push = OBJECT_PROPERTY_GROUP_END | TYPE_EXPRESSION_GROUP | TYPE_EXPRESSION_PROPERTY;
                if (method_body) stack[size - 1] &= ~TYPE_EXPRESSION_METHOD_BODY;
                if (c == '(' && (member_name || (frame & TYPE_EXPRESSION_FUNCTION))) {
                    push = METHOD_PARAMETER_GROUP_END | TYPE_EXPRESSION_GROUP | TYPE_GROUP_PARAMETER;
                    stack[size - 1] &= ~TYPE_EXPRESSION_FUNCTION;
                }
                if (c == ',' && (frame & TYPE_GROUP_ROLE_MASK) == OBJECT_PROPERTY_GROUP_END) stack[size - 1] |= TYPE_EXPRESSION_PROPERTY;
                if (c == '(') push |= TYPE_GROUP_PARAMETER;
                if (push) stack[size - 1] &= ~TYPE_EXPRESSION_BODY;
                stack[size - 1] &= ~TYPE_EXPRESSION_EMPTY_GROUP;
                if (expression_postfix && lexer->lookahead == c) advance(lexer);
                if (!expression_postfix && (c == '+' || c == '-' || (c == '*' && !member_name && !(frame & TYPE_EXPRESSION_FUNCTION)) || c == '%' || c == '^' || c == '|' || c == '&' || c == '=' || c == '>' || c == '?' || c == '~' || (c == '!' && lexer->lookahead == '=') || (c == ':' && (end != '}' || (frame & TYPE_GROUP_ROLE_MASK) == TYPE_SUBSTITUTION_GROUP_END || (frame & TYPE_GROUP_ROLE_MASK) == OBJECT_PROPERTY_GROUP_END)) || (c == ',' && end == ']' && (frame & TYPE_GROUP_ROLE_MASK) == COMPUTED_PROPERTY_GROUP_END))) {
                    stack[size - 1] |= TYPE_EXPRESSION_OPERAND;
                    stack[size - 1] &= ~TYPE_EXPRESSION_PROPERTY;
                } else if (c == '.') {
                    stack[size - 1] |= TYPE_EXPRESSION_PROPERTY;
                    if (is_ascii_digit(lexer->lookahead)) stack[size - 1] &= ~TYPE_EXPRESSION_OPERAND;
                } else if (push) {
                    stack[size - 1] &= ~TYPE_EXPRESSION_OPERAND;
                    if (!member_name || c != '[') stack[size - 1] &= ~TYPE_EXPRESSION_PROPERTY;
                    if (c == '(' && (push & TYPE_GROUP_ROLE_MASK) != METHOD_PARAMETER_GROUP_END && ((expression_operand && !(frame & TYPE_EXPRESSION_PROPERTY)) || (computed_expression && first_operand))) push |= TYPE_EXPRESSION_OPERAND | TYPE_EXPRESSION_EMPTY_GROUP;
                }
            }
            if (!is_whitespace(c)) {
                bool member_separator = c == ';' && frame == OBJECT_PROPERTY_GROUP_END;
                first_operand = c == '(' || c == '[' || c == '{' || c == '<' || c == ',' || c == '|' || c == '&' || c == '?' || c == ':' || c == '=' || member_separator;
                parameter_position = c == '(' || c == '[' || c == '{' || c == ',' || member_separator || push == TYPE_PARAMETER_GROUP_END || push == METHOD_TYPE_PARAMETER_GROUP_END || (c == '?' && (frame == OBJECT_PROPERTY_GROUP_END || frame == TYPE_OPERAND_GROUP_END) && parameter_position);
                operand_pending = expression_annotation;
                query_operand = false;
            }
        }
        if (push) {
            if (size == capacity) {
                capacity *= 2;
                int32_t *grown = ts_realloc(stack, capacity * sizeof(int32_t));
                if (!grown) break;
                stack = grown;
            }
            if ((push & TYPE_GROUP_ROLE_MASK) == TYPE_OPERAND_GROUP_END && !(push & TYPE_EXPRESSION_GROUP)) push |= TYPE_GROUP_PARAMETER;
            stack[size++] = push | (frame & TYPE_EXPRESSION_GROUP);
        }
    }
    ts_free(stack);
    return result;
}

static bool scan_annotated_type_colons(TSLexer *lexer, bool allow_expression) {
    unsigned conditional_depth = 0;
    bool saw_extends = false;
    bool first = true;
    bool query_operand = false;
    while (!lexer->eof(lexer)) {
        if (!scan_default_trivia(lexer, true, false)) return true;
        int32_t c = lexer->lookahead;
        if (c == ')' || c == ']' || c == '}' || c == ',' || c == ';' || c == '>') return true;
        if (is_identifier_part(c)) {
            char word[16] = {0};
            bool ascii_word = scan_identifier(lexer, word, sizeof(word), false);
            if (query_operand) {
                if (ascii_word && strcmp(word, "typeof") == 0) return false;
                query_operand = false;
            } else if (!allow_expression && first && ascii_word) {
                if (strcmp(word, "unique") == 0) {
                    if (!scan_default_trivia(lexer, true, false) || !scan_identifier(lexer, word, sizeof(word), false) || strcmp(word, "symbol") != 0) return false;
                } else if (strcmp(word, "typeof") == 0 || strcmp(word, "keyof") == 0 || strcmp(word, "readonly") == 0 || strcmp(word, "infer") == 0) {
                    if (!scan_default_trivia(lexer, true, false) || lexer->eof(lexer)) return false;
                    switch (lexer->lookahead) {
                        case '\\':
                            if (!scan_type_identifier_operand(lexer)) return false;
                            query_operand = false;
                            first = false;
                            continue;
                        case '-':
                        case '+':
                            if (strcmp(word, "typeof") == 0 || strcmp(word, "infer") == 0) return false;
                            advance(lexer);
                            if (!scan_default_trivia(lexer, true, false)) return false;
                            if (lexer->lookahead == '.') advance(lexer);
                            if (!is_ascii_digit(lexer->lookahead)) return false;
                            break;
                        case '.':
                            if (strcmp(word, "typeof") == 0 || strcmp(word, "infer") == 0) return false;
                            advance(lexer);
                            if (!is_ascii_digit(lexer->lookahead)) return false;
                            break;
                        case '%':
                        case '^':
                        case '!':
                        case '~':
                        case '@':
                        case '#':
                        case ')':
                        case ']':
                        case '}':
                        case ',':
                        case ';':
                        case ':':
                        case '=':
                        case '>':
                        case '|':
                        case '&':
                        case '?':
                            return false;
                        default:
                            break;
                    }
                    query_operand = strcmp(word, "typeof") == 0;
                    first = !query_operand && strcmp(word, "infer") != 0;
                    continue;
                }
            }
            bool extends_operand = ascii_word && strcmp(word, "extends") == 0;
            if (extends_operand) saw_extends = true;
            first = !allow_expression && (extends_operand || (first && ascii_word && (strcmp(word, "new") == 0 || strcmp(word, "abstract") == 0)));
            continue;
        }
        bool generic_parameters = !allow_expression && first && c == '<';
        advance(lexer);
        if ((c == '<' || c == '-') && scan_type_html_comment_tail(lexer, c)) return false;
        first = false;
        if (c == ':') {
            if (conditional_depth == 0) return false;
            conditional_depth--;
            first = !allow_expression;
        } else if (c == '?' && (saw_extends || allow_expression)) {
            if (allow_expression && lexer->lookahead == '?') advance(lexer);
            else if (allow_expression && lexer->lookahead == '.') {
                advance(lexer);
                if (is_ascii_digit(lexer->lookahead)) conditional_depth++;
            } else conditional_depth++;
            first = !allow_expression;
        } else if (!allow_expression && (c == '|' || c == '&')) {
            first = true;
        } else if (c == '=') {
            if (lexer->lookahead != '>') return true;
            advance(lexer);
            first = !allow_expression;
        } else if (c == '<' || c == '(' || c == '[' || c == '{') {
            int32_t close = c == '<' ? '>' : c == '(' ? ')' : c == '[' ? ']' : '}';
            if (!scan_type_group(lexer, generic_parameters ? TYPE_PARAMETER_GROUP_END : close, !allow_expression, true)) return allow_expression;
            first = generic_parameters || (!allow_expression && c == '(');
        } else if (c == '\'' || c == '"' || c == '`') {
            while (!lexer->eof(lexer) && lexer->lookahead != c) {
                int32_t part = lexer->lookahead;
                advance(lexer);
                if (part == '\\' && !lexer->eof(lexer)) advance(lexer);
                else if (c == '`' && part == '$' && lexer->lookahead == '{') {
                    advance(lexer);
                    if (!scan_type_group(lexer, allow_expression ? '}' : TYPE_SUBSTITUTION_GROUP_END, !allow_expression, true)) return allow_expression;
                }
            }
            if (!lexer->eof(lexer)) advance(lexer);
        }
    }
    return true;
}

static bool scan_type_identifier_operand(TSLexer *lexer) {
    int32_t character = scan_identifier_character(lexer);
    if (!is_identifier_part(character) || character == '\\' || is_ascii_digit(character)) return false;
    while (is_identifier_part(lexer->lookahead)) {
        character = scan_identifier_character(lexer);
        if (!is_identifier_part(character) || character == '\\') return false;
    }
    return true;
}

static bool scan_type_html_comment_tail(TSLexer *lexer, int32_t opening) {
    const char *tail = opening == '<' ? "!--" : "->";
    for (; *tail; tail++) {
        if (lexer->lookahead != *tail) return false;
        advance(lexer);
    }
    return true;
}

static inline bool external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
    Scanner *scanner = (Scanner *)payload;

    if (valid_symbols[REGEX_FLAGS_START] && !valid_symbols[AUTOMATIC_SEMICOLON]) {
        if (lexer->lookahead != '/') return false;
        lexer->mark_end(lexer);
        advance(lexer);
        if (lexer->lookahead < 'a' || lexer->lookahead > 'z') return false;
        lexer->result_symbol = REGEX_FLAGS_START;
        return true;
    }

    if (!valid_symbols[ERROR_RECOVERY] && (valid_symbols[HERITAGE_TYPE_START] || valid_symbols[HERITAGE_TYPE_END])) {
        lexer->mark_end(lexer);
        if (valid_symbols[HERITAGE_TYPE_END]) {
            bool comment = false;
            if (scan_whitespace_and_comments(lexer, &comment, true, true) == REJECT) return false;
            if (lexer->lookahead != ',' && lexer->lookahead != '{' && !lexer->eof(lexer)) return false;
        }
        scanner->heritage_type_pending = valid_symbols[HERITAGE_TYPE_START];
        lexer->result_symbol = scanner->heritage_type_pending ? HERITAGE_TYPE_START : HERITAGE_TYPE_END;
        return true;
    }

    if (valid_symbols[GLOBAL_DECLARATION_END] && !valid_symbols[ERROR_RECOVERY]) {
        return scan_global_declaration_end(lexer);
    }

    if (valid_symbols[TEMPLATE_CHARS]) {
        if (valid_symbols[AUTOMATIC_SEMICOLON]) {
            return false;
        }
        return scan_template_chars(lexer);
    }

    if (valid_symbols[EXPORT_DEFAULT] ||
        (valid_symbols[DEFAULT_DECLARATION_START] && scanner->default_declaration_pending)) {
        while (is_whitespace(lexer->lookahead)) skip(lexer);
        if (valid_symbols[EXPORT_DEFAULT] && lexer->lookahead == 'd') {
            return scan_export_default(scanner, lexer);
        }
        if (valid_symbols[DEFAULT_DECLARATION_START] && scanner->default_declaration_pending &&
            (lexer->lookahead == '@' || lexer->lookahead == 'a' || lexer->lookahead == 'c' || lexer->lookahead == 'f')) {
            lexer->mark_end(lexer);
            lexer->result_symbol = DEFAULT_DECLARATION_START;
            scanner->default_declaration_pending = false;
            return true;
        }
    }

    if (valid_symbols[POSTFIX_UPDATE_END]) {
        bool statement_end = false;
        bool ret = scan_expression_end(lexer, true, &statement_end, valid_symbols);
        scanner->automatic_semicolon_pending |= statement_end;
        return ret;
    }

    if (scanner->automatic_semicolon_pending && valid_symbols[AWAIT_OPERAND_END] &&
        !valid_symbols[COMPLETED_ARROW_FUNCTION] && !valid_symbols[LINE_BREAK_AFTER_AWAIT]) {
        lexer->mark_end(lexer);
        lexer->result_symbol = AWAIT_OPERAND_END;
        return true;
    }

    if (scanner->automatic_semicolon_pending &&
        (valid_symbols[AUTOMATIC_SEMICOLON] || valid_symbols[ARROW_FUNCTION_BLOCK_CONTINUATION])) {
        scanner->automatic_semicolon_pending = false;
        lexer->result_symbol =
            valid_symbols[AUTOMATIC_SEMICOLON] ? AUTOMATIC_SEMICOLON : ARROW_FUNCTION_BLOCK_CONTINUATION;
        lexer->mark_end(lexer);
        return true;
    }

    if (valid_symbols[TYPE_ARGUMENTS_END] || valid_symbols[TYPE_ARGUMENTS_END_BEFORE_EXPRESSION] ||
        valid_symbols[NEW_TYPE_ARGUMENTS_END]) {
        return scan_type_arguments_end(lexer, valid_symbols);
    }

    if (valid_symbols[JSX_TEXT] && scan_jsx_text(lexer)) {
        return true;
    }

    if (valid_symbols[AWAIT_YIELD_IDENTIFIER_CONTEXT] && valid_symbols[AWAIT_YIELD_IDENTIFIER]) {
        return scan_await_yield_identifier(lexer);
    }

    if (!valid_symbols[AWAIT_OPERAND_END] && !valid_symbols[PLAIN_RESOURCE_FOR_OF_CONTEXT] &&
        valid_symbols[RESOURCE_BINDING_START]) {
        bool scanned_content = false;
        bool before_line_break = false;
        bool ret = scan_automatic_semicolon(lexer, valid_symbols, !valid_symbols[LOGICAL_OR], false, LINE_BREAK_BY_NEXT_TOKEN,
                                            &scanned_content, &before_line_break, true);
        if (ret && lexer->result_symbol == AUTOMATIC_SEMICOLON) {
            if (!valid_symbols[AUTOMATIC_SEMICOLON]) {
                return false;
            }
            if (valid_symbols[STATEMENT_BOUNDARY]) {
                lexer->result_symbol = STATEMENT_BOUNDARY;
            }
        }
        if (!ret && !scanned_content && valid_symbols[TERNARY_QMARK] && lexer->lookahead == '?') {
            return scan_ternary_qmark(lexer);
        }
        return ret;
    }

    if ((valid_symbols[AWAIT_OPERAND_END] && !valid_symbols[LINE_BREAK_AFTER_AWAIT]) ||
        valid_symbols[RESOURCE_BINDING_START] || valid_symbols[RESOURCE_BINDING_CONTINUATION] ||
        valid_symbols[PLAIN_RESOURCE_FOR_OF_CONTEXT]) {
        if (valid_symbols[COMPLETED_ARROW_FUNCTION]) {
            return valid_symbols[TERNARY_QMARK] && scan_ternary_qmark(lexer);
        }
        bool statement_end = false;
        bool ret = scan_expression_end(lexer, false, &statement_end, valid_symbols);
        scanner->automatic_semicolon_pending |= statement_end;
        return ret;
    }

    if (valid_symbols[AUTOMATIC_SEMICOLON] || valid_symbols[FUNCTION_SIGNATURE_AUTOMATIC_SEMICOLON] ||
        valid_symbols[ARROW_FUNCTION_BLOCK_END] || valid_symbols[TYPE_MEMBER_SEMICOLON]) {
        bool after_block_arrow = valid_symbols[ARROW_FUNCTION_BLOCK_END];
        bool scanned_content = false;
        LineBreakRule rule = LINE_BREAK_BY_NEXT_TOKEN;
        if (valid_symbols[LINE_BREAK_AFTER_AWAIT]) {
            rule = LINE_BREAK_AFTER_AWAIT_KEYWORD;
        } else if (valid_symbols[LINE_BREAK_ENDS_STATEMENT] || (valid_symbols[TYPE_MEMBER_SEMICOLON] && !valid_symbols[LINE_BREAK_AFTER_FIELD])) {
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
        bool before_line_break = false;
        bool ret = scan_automatic_semicolon(lexer, valid_symbols, !valid_symbols[LOGICAL_OR], after_block_arrow, rule, &scanned_content, &before_line_break, false);
        if (ret && valid_symbols[TYPE_MEMBER_SEMICOLON]) lexer->result_symbol = TYPE_MEMBER_SEMICOLON;
        if (ret && after_block_arrow) {
            lexer->result_symbol = ARROW_FUNCTION_BLOCK_END;
            scanner->automatic_semicolon_pending = true;
        }
        if (ret && !after_block_arrow && valid_symbols[STATEMENT_BOUNDARY] && !valid_symbols[NAMESPACE_EXPRESSION_END] && lexer->result_symbol == AUTOMATIC_SEMICOLON) {
            lexer->result_symbol = STATEMENT_BOUNDARY;
        }
        if (!ret && !scanned_content && valid_symbols[TERNARY_QMARK] && lexer->lookahead == '?') {
            return scan_ternary_qmark(lexer);
        }
        if (!ret && before_line_break && !scanned_content && valid_symbols[GLOBAL_DECLARATION_START] &&
            !valid_symbols[ERROR_RECOVERY] && (lexer->lookahead == 'g' || lexer->lookahead == '\\')) {
            return scan_global_declaration_start(lexer);
        }
        if (!ret && !scanned_content && valid_symbols[HTML_COMMENT] && !valid_symbols[LOGICAL_OR] &&
            !valid_symbols[ESCAPE_SEQUENCE] && !valid_symbols[REGEX_PATTERN] &&
            (lexer->lookahead == '<' || lexer->lookahead == '-')) {
            return scan_html_comment(lexer);
        }
        if (!ret && !scanned_content && valid_symbols[AWAIT_YIELD_IDENTIFIER] && valid_symbols[LINE_BREAK_AFTER_AWAIT] && lexer->lookahead == 'y') {
            return scan_await_yield_identifier(lexer);
        }
        if (!ret && !scanned_content && valid_symbols[AWAIT_KEYWORD] && lexer->lookahead == 'a') {
            return scan_await_keyword(lexer);
        }
        if (!ret && !scanned_content && valid_symbols[LET] && !valid_symbols[SINGLE_STATEMENT_CONTEXT] && lexer->lookahead == 'l') {
            lexer->result_symbol = LET;
            return scan_let(lexer);
        }
        return ret;
    }

    if ((valid_symbols[TYPE_REFERENCE_ARGUMENTS_START] || valid_symbols[UNQUALIFIED_TYPE_REFERENCE_ARGUMENTS_START] || valid_symbols[ABSTRACT_CONSTRUCTOR_PREFIX] ||
         ((valid_symbols[PREDEFINED_PARAMETER_NAME] || valid_symbols[PREDEFINED_ANNOTATED_NAME]) && (lexer->lookahead == 'u' || lexer->lookahead == 'n'))) && !valid_symbols[ERROR_RECOVERY]) {
        bool result = scan_type_reference_arguments_start(lexer, valid_symbols, scanner->heritage_type_pending);
        if (result && lexer->result_symbol != ABSTRACT_CONSTRUCTOR_PREFIX &&
            lexer->result_symbol != PREDEFINED_PARAMETER_NAME &&
            lexer->result_symbol != PREDEFINED_ANNOTATED_NAME) scanner->heritage_type_pending = false;
        return result;
    }

    if (valid_symbols[AWAIT_YIELD_IDENTIFIER] && valid_symbols[LINE_BREAK_AFTER_AWAIT]) {
        while (is_whitespace(lexer->lookahead)) {
            skip(lexer);
        }
        if (lexer->lookahead == 'y') {
            return scan_await_yield_identifier(lexer);
        }
    }

    while (is_whitespace(lexer->lookahead)) {
        skip(lexer);
    }
    if (valid_symbols[GLOBAL_DECLARATION_START] && !valid_symbols[ERROR_RECOVERY] &&
        (lexer->lookahead == 'g' || lexer->lookahead == '\\')) {
        return scan_global_declaration_start(lexer);
    }
    if (valid_symbols[AWAIT_KEYWORD] && lexer->lookahead == 'a') {
        return scan_await_keyword(lexer);
    }
    if (valid_symbols[TERNARY_QMARK] && lexer->lookahead == '?') {
        return scan_ternary_qmark(lexer);
    }

    if (valid_symbols[LET] && !valid_symbols[SINGLE_STATEMENT_CONTEXT] && lexer->lookahead == 'l') {
        lexer->result_symbol = LET;
        return scan_let(lexer);
    }

    if (valid_symbols[HTML_COMMENT] && !valid_symbols[LOGICAL_OR] && !valid_symbols[ESCAPE_SEQUENCE] &&
        !valid_symbols[REGEX_PATTERN] && (lexer->lookahead == '<' || lexer->lookahead == '-')) {
        return scan_html_comment(lexer);
    }
    if (valid_symbols[JSX_CLOSING_RECOVERY_IDENTIFIER] && !valid_symbols[ERROR_RECOVERY]) {
        return scan_jsx_closing_recovery_identifier(lexer);
    }
    if ((valid_symbols[PREDEFINED_PARAMETER_NAME] || valid_symbols[PREDEFINED_ANNOTATED_NAME]) && !valid_symbols[ERROR_RECOVERY] &&
        (lexer->lookahead == 'u' || lexer->lookahead == 'n')) {
        return scan_type_reference_arguments_start(lexer, valid_symbols, scanner->heritage_type_pending);
    }
    return false;
}

static bool scan_let(TSLexer *lexer) {
    for (const char *word = "let"; *word; word++) {
        if (lexer->lookahead != *word) return false;
        advance(lexer);
    }
    if (is_identifier_part(lexer->lookahead)) return false;
    lexer->mark_end(lexer);
    bool line_start = false;
    for (;;) {
        while (is_whitespace(lexer->lookahead)) {
            line_start |= is_line_terminator(lexer->lookahead);
            advance(lexer);
        }
        if (lexer->lookahead == '<' || (line_start && lexer->lookahead == '-')) {
            const char *prefix = lexer->lookahead == '<' ? "<!--" : "-->";
            for (; *prefix; prefix++) {
                if (lexer->lookahead != *prefix) return false;
                advance(lexer);
            }
            while (!lexer->eof(lexer) && !is_line_terminator(lexer->lookahead)) advance(lexer);
            continue;
        }
        if (lexer->lookahead != '/') break;
        advance(lexer);
        if (lexer->lookahead == '/') {
            while (!lexer->eof(lexer) && !is_line_terminator(lexer->lookahead)) advance(lexer);
        } else if (lexer->lookahead == '*') {
            advance(lexer);
            bool star = false;
            while (!lexer->eof(lexer)) {
                if (star && lexer->lookahead == '/') break;
                star = lexer->lookahead == '*';
                line_start |= is_line_terminator(lexer->lookahead);
                advance(lexer);
            }
            if (lexer->eof(lexer)) return false;
            advance(lexer);
        } else {
            return false;
        }
    }
    if (lexer->lookahead == '[' || lexer->lookahead == '{') return true;
    if (!is_identifier_part(lexer->lookahead) || is_ascii_digit(lexer->lookahead)) return false;
    char name[16] = {0};
    unsigned length = 0;
    while (is_identifier_part(lexer->lookahead)) {
        if (length == sizeof(name) - 1) return true;
        name[length++] = lexer->lookahead < 0x80 ? (char)lexer->lookahead : '?';
        advance(lexer);
    }
    return !is_reserved_word(name);
}

static bool is_reserved_word(const char *name) {
    static const char *const reserved[] = {
        "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else",
        "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new",
        "null", "return", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with"
    };
    for (unsigned i = 0; i < sizeof(reserved) / sizeof(reserved[0]); i++) {
        if (strcmp(name, reserved[i]) == 0) return true;
    }
    return false;
}

static bool scan_export_default(Scanner *scanner, TSLexer *lexer) {
    while (is_whitespace(lexer->lookahead)) {
        skip(lexer);
    }
    for (const char *word = "default"; *word; word++) {
        if (lexer->lookahead != *word) {
            return false;
        }
        advance(lexer);
    }
    if (is_identifier_part(lexer->lookahead)) {
        return false;
    }
    lexer->mark_end(lexer);
    lexer->result_symbol = EXPORT_DEFAULT;
    scanner->default_declaration_pending = false;
    if (!scan_default_trivia(lexer, true, true)) return true;
    if (lexer->lookahead == '@') {
        scanner->default_declaration_pending = true;
    } else {
        char word[16] = {0};
        if (!scan_identifier(lexer, word, sizeof(word), false)) return true;
        if (strcmp(word, "function") == 0 || strcmp(word, "class") == 0) {
            scanner->default_declaration_pending = true;
        } else if (strcmp(word, "abstract") == 0 && scan_default_trivia(lexer, false, true)) {
            memset(word, 0, sizeof(word));
            scanner->default_declaration_pending =
                scan_identifier(lexer, word, sizeof(word), false) && strcmp(word, "class") == 0;
        } else if (strcmp(word, "async") == 0 && scan_default_trivia(lexer, false, true)) {
            memset(word, 0, sizeof(word));
            scanner->default_declaration_pending =
                scan_identifier(lexer, word, sizeof(word), false) && strcmp(word, "function") == 0;
        }
    }
    return true;
}

static bool scan_jsx_closing_recovery_identifier(TSLexer *lexer) {
    while (is_whitespace(lexer->lookahead)) skip(lexer);
    if (lexer->lookahead != 'i') return false;
    advance(lexer);
    if (lexer->lookahead != 's') return false;
    advance(lexer);
    if (is_identifier_part(lexer->lookahead) || lexer->lookahead == '-') return false;
    lexer->mark_end(lexer);
    if (!scan_default_trivia(lexer, true, true)) {
        if (!lexer->eof(lexer)) return false;
    } else if (lexer->lookahead == '.' || lexer->lookahead == ':') {
        advance(lexer);
        if (!scan_default_trivia(lexer, true, true)) {
            if (!lexer->eof(lexer)) return false;
        } else if (is_identifier_part(lexer->lookahead) && !is_ascii_digit(lexer->lookahead)) {
            return false;
        }
    } else if (lexer->lookahead == '>') {
        return false;
    }
    lexer->result_symbol = JSX_CLOSING_RECOVERY_IDENTIFIER;
    return true;
}

static bool scan_default_trivia(TSLexer *lexer, bool allow_line_breaks, bool html_comments) {
    for (;;) {
        while (is_whitespace(lexer->lookahead)) {
            if (!allow_line_breaks && is_line_terminator(lexer->lookahead)) return false;
            advance(lexer);
        }
        if (lexer->lookahead == '/') {
            advance(lexer);
            if (lexer->lookahead == '*') {
                advance(lexer);
                bool closed = false;
                while (!lexer->eof(lexer)) {
                    if (!allow_line_breaks && is_line_terminator(lexer->lookahead)) return false;
                    if (lexer->lookahead == '*') {
                        advance(lexer);
                        if (lexer->lookahead == '/') {
                            advance(lexer);
                            closed = true;
                            break;
                        }
                    } else {
                        advance(lexer);
                    }
                }
                if (!closed) return false;
                continue;
            }
            if (lexer->lookahead != '/') return false;
        } else if (html_comments && (lexer->lookahead == '<' || lexer->lookahead == '-')) {
            const char *opening = lexer->lookahead == '<' ? "<!--" : "-->";
            for (; *opening; opening++) {
                if (lexer->lookahead != *opening) return false;
                advance(lexer);
            }
        } else {
            return true;
        }
        while (!lexer->eof(lexer) && !is_line_terminator(lexer->lookahead)) advance(lexer);
    }
}
