#include "functionContext.h"
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
    EXPORT_DEFAULT_DECLARATION,
    DEFAULT_DECLARATION_START,
    REGEX_FLAGS_START,
    ARGUMENTLESS_NEW_END,
    CONSTRUCTOR_ASYNC_FUNCTION_START,
    SYNC_FUNCTION_START,
    ASYNC_FUNCTION_START,
    FUNCTION_CONTEXT_END,
    ARROW_CONTEXT_END,
    AWAIT_IDENTIFIER,
    GENERATOR_FUNCTION_START,
    ASYNC_GENERATOR_FUNCTION_START,
    YIELD_KEYWORD,
    YIELD_IDENTIFIER,
    FUNCTION_SIGNATURE_START,
    ASYNC_FUNCTION_SIGNATURE_START,
    CALL_ARGUMENTS_CONTEXT,
    ASYNC_KEYWORD,
    FUNCTION_SIGNATURE_AUTOMATIC_SEMICOLON,
    TYPE_ARGUMENTS_END,
    TYPE_ARGUMENTS_END_BEFORE_EXPRESSION,
    NEW_TYPE_ARGUMENTS_END,
    TYPE_REFERENCE_ARGUMENTS_START,
    UNQUALIFIED_TYPE_REFERENCE_ARGUMENTS_START,
    TYPE_MEMBER_SEMICOLON,
    HERITAGE_TYPE_START,
    HERITAGE_TYPE_END,
    KEYWORD_HERITAGE_ARGUMENTS_END,
    GLOBAL_DECLARATION_START,
    GLOBAL_DECLARATION_END,
    ERROR_RECOVERY,
    NAMESPACE_EXPRESSION_END,
    ABSTRACT_CONSTRUCTOR_PREFIX,
    JSX_CLOSING_RECOVERY_IDENTIFIER,
    PREDEFINED_PARAMETER_NAME,
    PREDEFINED_ANNOTATED_NAME,
    ARROW_PREDEFINED_RETURN_START,
    CONDITIONAL_PREDEFINED_PARAMETER_NAME,
    COMMENT_OPTIONAL_PARAMETER_MARKER,
    METHOD_SIGNATURE_END,
    FUNCTION_SIGNATURE_END,
    BARE_ASSERTION_CONTEXT,
    ANNOTATED_SIGNATURE_CONTEXT,
    TYPE_ASSERTION_CONTEXT,
    IMPORT_TYPE_ARGUMENTS_START,
};

static bool scan_let(TSLexer *lexer);
static bool scan_block_comment(TSLexer *lexer, bool *saw_newline, bool skip_contents);
static bool scan_expression_trivia(TSLexer *lexer, bool *saw_newline, bool *scanned_comment);
static bool scan_async_start(TSLexer *lexer, char *keyword, unsigned capacity, const bool *valid_symbols);
static bool is_reserved_word(const char *name);

typedef struct {
    // A reused block arrow or postfix update can bypass the boundary state; serialize the pending semicolon.
    // Nested await end tokens must not clear it before the enclosing statement consumes it.
    bool automatic_semicolon_pending;
    bool heritage_type_pending;
    bool default_declaration_pending;
    FunctionContext functions;
} Scanner;

static bool await_is_identifier(const Scanner *scanner);

static bool scan_export_default(Scanner *scanner, TSLexer *lexer);
static bool scan_default_trivia(TSLexer *lexer, bool allow_line_breaks, bool html_comments);
static bool scan_default_trivia_with_line_break(TSLexer *lexer, bool allow_line_breaks, bool html_comments, bool *line_break);
static bool scan_jsx_closing_recovery_identifier(TSLexer *lexer);

static inline void *external_scanner_create() { return ts_calloc(1, sizeof(Scanner)); }

static inline void external_scanner_destroy(void *payload) { ts_free(payload); }

static inline unsigned external_scanner_serialize(void *payload, char *buffer) {
    Scanner *scanner = (Scanner *)payload;
    buffer[0] = (char)scanner->automatic_semicolon_pending;
    buffer[1] = (char)scanner->heritage_type_pending;
    buffer[2] = (char)scanner->default_declaration_pending;
    return 3 + function_context_serialize(&scanner->functions, buffer + 3);
}

static inline void external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
    Scanner *scanner = (Scanner *)payload;
    scanner->automatic_semicolon_pending = length > 0 && buffer[0];
    scanner->heritage_type_pending = length > 1 && buffer[1];
    scanner->default_declaration_pending = length > 2 && buffer[2];
    function_context_deserialize(&scanner->functions, length >= 3 ? buffer + 3 : buffer, length >= 3 ? length - 3 : 0);
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
    // The probe crossed a comment-related line break, so ASI cannot rely on finding it at the current lookahead.
    ACCEPT_AFTER_COMMENT_LINE_BREAK,
    ACCEPT_AFTER_COMMENT_LINE_BREAK_BEFORE_SLASH,
} WhitespaceResult;

/**
 * @param consume If false, only consume enough to check if comment indicates semicolon-legality
 */
static WhitespaceResult scan_whitespace_and_comments(TSLexer *lexer, bool *scanned_content, bool consume, bool skip_contents) {
    bool saw_comment_newline = false;
    for (;;) {
        while (is_whitespace(lexer->lookahead)) {
            lexer->advance(lexer, skip_contents);
        }
        if (lexer->lookahead != '/') return ACCEPT;
        lexer->advance(lexer, skip_contents);
        if (lexer->lookahead == '/') {
            lexer->advance(lexer, skip_contents);
            while (!lexer->eof(lexer) && !is_line_terminator(lexer->lookahead)) {
                lexer->advance(lexer, skip_contents);
            }
            saw_comment_newline |= is_line_terminator(lexer->lookahead);
            *scanned_content = true;
            continue;
        }
        if (lexer->lookahead != '*') {
            return !consume && saw_comment_newline ? ACCEPT_AFTER_COMMENT_LINE_BREAK_BEFORE_SLASH : REJECT;
        }
        lexer->advance(lexer, skip_contents);
        if (!scan_block_comment(lexer, &saw_comment_newline, skip_contents)) return ACCEPT;
        *scanned_content = true;
        if (!consume && lexer->lookahead != '/') {
            return saw_comment_newline ? ACCEPT_AFTER_COMMENT_LINE_BREAK : NO_NEWLINE;
        }
    }
}

static bool scan_block_comment(TSLexer *lexer, bool *saw_newline, bool skip_contents) {
    while (!lexer->eof(lexer)) {
        if (lexer->lookahead != '*') {
            *saw_newline |= is_line_terminator(lexer->lookahead);
            lexer->advance(lexer, skip_contents);
            continue;
        }
        lexer->advance(lexer, skip_contents);
        if (lexer->lookahead == '/') {
            lexer->advance(lexer, skip_contents);
            return true;
        }
    }
    return false;
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
    LINE_BREAK_AWAIT_OPERAND,
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
    bool line_break_in_comment = false;
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
            if (result == ACCEPT_AFTER_COMMENT_LINE_BREAK_BEFORE_SLASH) {
                return scan_after_line_break(lexer, valid_symbols, after_block_arrow, rule, scanned_content, true);
            }

            if (after_block_arrow && lexer->eof(lexer)) {
                return true;
            }

            if (result == NO_NEWLINE && rule == LINE_BREAK_AFTER_AWAIT_KEYWORD) {
                return false;
            }
            if (result == ACCEPT || result == ACCEPT_AFTER_COMMENT_LINE_BREAK) {
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
                line_break_in_comment = result == ACCEPT_AFTER_COMMENT_LINE_BREAK;
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
            return line_break_in_comment && scan_after_line_break(lexer, valid_symbols, false, rule, scanned_content, false);
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
        case LINE_BREAK_AWAIT_OPERAND:
            return false;
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

static bool scan_question_mark(TSLexer *lexer, const bool *valid_symbols) {
    while (is_whitespace(lexer->lookahead)) skip(lexer);
    if (lexer->lookahead != '?') return false;
    advance(lexer);
    if (lexer->lookahead == '?') return false;
    lexer->mark_end(lexer);
    lexer->result_symbol = TERNARY_QMARK;
    while (is_whitespace(lexer->lookahead)) advance(lexer);

    bool comment_candidate = valid_symbols[COMMENT_OPTIONAL_PARAMETER_MARKER] &&
        !valid_symbols[ERROR_RECOVERY] && lexer->lookahead == '/';
    if (comment_candidate && scan_default_trivia(lexer, true, false) &&
        (lexer->lookahead == ':' || lexer->lookahead == ')' || lexer->lookahead == ',')) {
        lexer->result_symbol = COMMENT_OPTIONAL_PARAMETER_MARKER;
        return true;
    }
    if (comment_candidate) return valid_symbols[TERNARY_QMARK];
    if (lexer->lookahead == ':' || lexer->lookahead == ')' || lexer->lookahead == ',') return false;
    if (lexer->lookahead == '.') {
        advance(lexer);
        return valid_symbols[TERNARY_QMARK] && is_ascii_digit(lexer->lookahead);
    }
    return valid_symbols[TERNARY_QMARK];
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
            return !scanned_comment && (valid_symbols[TERNARY_QMARK] || valid_symbols[COMMENT_OPTIONAL_PARAMETER_MARKER]) && lexer->lookahead == '?' && scan_question_mark(lexer, valid_symbols);
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

#ifndef JAVASCRIPT_SCRIPT_GOAL
#define JAVASCRIPT_SCRIPT_GOAL false
#endif

static bool scan_yield(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols, bool await_operand) {
    bool scanned_content = false;
    if (scan_whitespace_and_comments(lexer, &scanned_content, true, true) == REJECT || scanned_content) return false;
    for (const char *word = "yield"; *word; word++) {
        if (lexer->lookahead != *word) return false;
        advance(lexer);
    }
    if (is_identifier_part(lexer->lookahead)) return false;
    bool identifier = (scanner->functions.depth || JAVASCRIPT_SCRIPT_GOAL) && !function_context_generator(&scanner->functions);
    TSSymbol symbol = await_operand ? AWAIT_YIELD_IDENTIFIER : identifier ? YIELD_IDENTIFIER : YIELD_KEYWORD;
    if (!valid_symbols[symbol]) return false;
    lexer->mark_end(lexer);
    lexer->result_symbol = symbol;
    return true;
}

static bool scan_await_or_async(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    lexer->mark_end(lexer);
    char keyword[16] = {0};
    if (!scan_identifier(lexer, keyword, sizeof(keyword), false)) return false;
    if (strcmp(keyword, "async") == 0) return scan_async_start(lexer, keyword, sizeof(keyword), valid_symbols);
    if (strcmp(keyword, "await") != 0) return false;
    bool identifier = await_is_identifier(scanner);
    if (identifier ? !valid_symbols[AWAIT_IDENTIFIER] : !valid_symbols[AWAIT_KEYWORD]) return false;
    lexer->mark_end(lexer);
    // Record the operand decision on both keyword and identifier tokens so restored nodes cannot keep stale roles.
    // Advancing without skipping after mark_end preserves the consuming keyword's start across probed comments.
    bool scanned_content = false;
    for (unsigned words = 0; words <= 2; words++) {
        if (scan_whitespace_and_comments(lexer, &scanned_content, true, false) == REJECT ||
            words == 2 || !is_identifier_part(lexer->lookahead)) {
            break;
        }
        char word[16] = {0};
        scan_identifier(lexer, word, sizeof(word), false);
    }
    lexer->result_symbol = identifier ? AWAIT_IDENTIFIER : AWAIT_KEYWORD;
    return true;
}

static bool scan_generic_function_type(TSLexer *lexer);
static bool scan_annotated_type_colons(TSLexer *lexer, bool allow_expression, bool first, bool untyped_return, bool enclosing_conditional, bool *requires_conditional_parameter);
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
    TYPE_QUERY_ARGUMENT_GROUP = 1 << 25,
    TYPE_GROUP_FORMAL_BINDING = 1 << 26,
};
typedef enum {
    TYPE_GROUP_NO_PREFIX,
    TYPE_GROUP_PRIMARY_PREFIX = 1 << 0,
    TYPE_GROUP_CONSTRUCTOR_PREFIX = 1 << 1,
    TYPE_GROUP_ABSTRACT_PREFIX = 1 << 2,
    TYPE_GROUP_MEMBER_QUERY_PREFIX = 1 << 3,
    TYPE_GROUP_IMPORT_QUERY_PREFIX = 1 << 4,
    TYPE_GROUP_TYPE_PREFIX = 1 << 5,
    TYPE_GROUP_READONLY_PREFIX = 1 << 6,
    TYPE_GROUP_UNIQUE_PREFIX = 1 << 7,
    TYPE_GROUP_ASSERTS_PREFIX = 1 << 8,
    TYPE_GROUP_PREDICATE_PREFIX = 1 << 9,
    TYPE_GROUP_PARENTHESIZED_HEADER = 1 << 10,
    TYPE_GROUP_ASSERTION_PREDICATE = 1 << 12,
    TYPE_GROUP_DEFAULT_IDENTIFIER = 1 << 11,
    TYPE_GROUP_ASSERTION_SUBJECT = 1 << 13,
    TYPE_GROUP_REFERENCE_LINE_BREAK = 1 << 14,
} TypeGroupPrefix;
typedef enum {
    TYPE_PARAMETER_PATTERN_NONE,
    TYPE_PARAMETER_PATTERN_NAME,
    TYPE_PARAMETER_PATTERN_MODIFIER,
    TYPE_PARAMETER_PATTERN_NON_PATTERN,
    TYPE_PARAMETER_PATTERN_INVALID,
    TYPE_PARAMETER_PATTERN_TYPE_ONLY,
    TYPE_PARAMETER_PATTERN_TYPE_ONLY_NON_PATTERN,
    TYPE_PARAMETER_PATTERN_PUNCTUATED_NAME,
    TYPE_PARAMETER_PATTERN_MEMBER_NAME,
    TYPE_PARAMETER_PATTERN_MASK = 15,
    TYPE_PARAMETER_PATTERN_INVALID_SLOT = 1 << 4,
    TYPE_PARAMETER_PATTERN_REST_SLOT = 1 << 5,
    TYPE_PARAMETER_PATTERN_OPTIONAL_SLOT = 1 << 6,
    TYPE_PARAMETER_PATTERN_COMPLETED_BINDING = 1 << 7,
    TYPE_PARAMETER_PATTERN_OBJECT_CANDIDATE = 1 << 8,
    TYPE_PARAMETER_PATTERN_ANNOTATABLE_OBJECT = 1 << 9,
} TypeParameterPattern;
enum TypeGroupCompletion {
    TYPE_GROUP_RETURN_OPERAND = 1,
    TYPE_GROUP_RETURN_IDENTIFIER = 2,
    TYPE_GROUP_TRAILING_LINE_BREAK = 4,
};
typedef enum {
    TYPE_PREDICATE_SUBJECT_NONE,
    TYPE_PREDICATE_SUBJECT_NAME,
    TYPE_PREDICATE_SUBJECT_COMPOSED,
} TypePredicateSubject;
typedef enum {
    TYPE_RETURN_NONE,
    TYPE_RETURN_FUNCTION,
    TYPE_RETURN_CONSTRUCTOR,
} TypeReturnOwner;
enum TypeObjectQueryOwner {
    TYPE_OBJECT_QUERY_PARENTHESIZED = 1,
    TYPE_OBJECT_QUERY_RETURN = 2,
};
typedef struct {
    int32_t context;
    TypeGroupPrefix prefix;
    TypePredicateSubject predicate_subject;
    unsigned parameter_pattern;
    unsigned conditional_depth;
    bool question_pending;
    bool conditional_candidate;
    bool conditional_branch;
    bool infer_name;
    bool infer_constraint;
    bool property;
    bool operand_required;
    bool exact_object;
    bool binding_type;
    bool default_value;
    bool default_parameter;
    bool default_declaration_header;
    bool default_type;
    bool nonreference_type;
    bool query_call_operand;
    bool query_argument_ancestor;
    TypeReturnOwner return_owner;
    unsigned object_query_owner;
    bool expression_only;
    bool parameter_header;
} TypeGroupFrame;

static bool scan_type_group(TSLexer *lexer, int32_t close, bool type_operands, bool html_comments, unsigned *completion, bool complete_conditionals, bool *unsafe_conditional);
static bool scan_type_html_comment_tail(TSLexer *lexer, int32_t opening);
static bool scan_type_identifier_operand(TSLexer *lexer);
static bool starts_non_identifier_type_operand(int32_t c);
static bool scan_type_question_tail(TSLexer *lexer, bool conditional);
static bool scan_type_numeric_operand(TSLexer *lexer);
static bool is_type_probe_punctuation(int32_t c);
static bool is_nonreference_type_word(const char *word);
static bool is_type_predicate_name_word(int32_t first, const char *word, bool ascii_word);
static bool is_type_probe_word(const char *word, const char *const *words, unsigned count);
static bool is_query_argument_expression(const TypeGroupFrame *stack, unsigned size);
static TypeGroupPrefix update_type_group_prefix(TypeGroupPrefix prefix, const char *word, bool first, bool *unsafe_conditional);

static bool scan_type_reference_arguments_start(TSLexer *lexer, const bool *valid_symbols, bool heritage) {
    bool conditional_parameter = valid_symbols[CONDITIONAL_PREDEFINED_PARAMETER_NAME];
    bool unqualified = valid_symbols[UNQUALIFIED_TYPE_REFERENCE_ARGUMENTS_START] || conditional_parameter;
    bool allow_type_arguments = valid_symbols[UNQUALIFIED_TYPE_REFERENCE_ARGUMENTS_START] || valid_symbols[TYPE_REFERENCE_ARGUMENTS_START];
    while (is_whitespace(lexer->lookahead)) skip(lexer);
    lexer->mark_end(lexer);
    bool comment = false;
    bool private_name = lexer->lookahead == '#';
    if (private_name) advance(lexer);
    if (!is_identifier_part(lexer->lookahead) || is_ascii_digit(lexer->lookahead)) return false;
    char word[16] = {0};
    bool ascii_word = scan_identifier(lexer, word, sizeof(word), false);
    if (unqualified && (valid_symbols[PREDEFINED_PARAMETER_NAME] || valid_symbols[PREDEFINED_ANNOTATED_NAME] || conditional_parameter) && !private_name && ascii_word &&
        (strcmp(word, "unknown") == 0 || strcmp(word, "never") == 0 || strcmp(word, "unique") == 0 || strcmp(word, "infer") == 0 || strcmp(word, "readonly") == 0 || strcmp(word, "keyof") == 0)) {
        lexer->mark_end(lexer);
        if (!scan_default_trivia(lexer, true, true)) return false;
        bool optional_parameter = lexer->lookahead == '?';
        if (strcmp(word, "readonly") == 0 && !optional_parameter) return false;
        if (optional_parameter) {
            advance(lexer);
            if (!scan_default_trivia(lexer, true, true)) return false;
        }
        bool untyped_parameter = lexer->lookahead == ')' || lexer->lookahead == ',';
        if (untyped_parameter && (strcmp(word, "infer") == 0 || strcmp(word, "readonly") == 0 || strcmp(word, "keyof") == 0)) return false;
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
            if (!scan_annotated_type_colons(lexer, false, true, false, false, NULL)) return false;
        }
        if (untyped_parameter) {
            if (!valid_symbols[PREDEFINED_PARAMETER_NAME] && !conditional_parameter) return false;
            lexer->result_symbol = conditional_parameter ? CONDITIONAL_PREDEFINED_PARAMETER_NAME : PREDEFINED_PARAMETER_NAME;
        } else if (!optional_parameter && valid_symbols[PREDEFINED_ANNOTATED_NAME]) {
            lexer->result_symbol = PREDEFINED_ANNOTATED_NAME;
        } else if (valid_symbols[PREDEFINED_PARAMETER_NAME]) {
            lexer->result_symbol = PREDEFINED_PARAMETER_NAME;
        } else {
            return false;
        }
        if (!scan_type_group(lexer, untyped_parameter ? UNTYPED_PARAMETER_GROUP_END : ')', false, true, NULL, false, NULL) || !scan_default_trivia(lexer, true, false) || lexer->lookahead != '=') return false;
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
        bool requires_conditional_parameter = false;
        if (!scan_annotated_type_colons(lexer, !untyped_parameter, !return_identifier, untyped_parameter, conditional_parameter, &requires_conditional_parameter)) return false;
        if (untyped_parameter && !requires_conditional_parameter) {
            if (!valid_symbols[PREDEFINED_PARAMETER_NAME]) return false;
            lexer->result_symbol = PREDEFINED_PARAMETER_NAME;
        }
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
    if (!scan_type_group(lexer, '>', false, false, NULL, false, NULL) || !scan_type_whitespace_and_comments(lexer, &comment, false) || lexer->lookahead != '(') return false;
    advance(lexer);
    if (!scan_type_group(lexer, ')', false, false, NULL, false, NULL) || !scan_type_whitespace_and_comments(lexer, &comment, false) || lexer->lookahead != '=') return false;
    advance(lexer);
    return lexer->lookahead == '>';
}

static bool scan_type_group(TSLexer *lexer, int32_t close, bool type_operands, bool html_comments, unsigned *completion, bool complete_conditionals, bool *unsafe_conditional) {
    if (completion) *completion = 0;
    unsigned size = 1, capacity = 32;
    TypeGroupFrame *stack = ts_malloc(capacity * sizeof(TypeGroupFrame));
    if (!stack) return false;
    stack[0] = (TypeGroupFrame){.context = type_operands && close == '}' ? OBJECT_PROPERTY_GROUP_END : type_operands && (close & ~(TYPE_QUERY_ARGUMENT_GROUP | TYPE_GROUP_FORMAL_BINDING)) == ')' ? TYPE_OPERAND_GROUP_END | TYPE_GROUP_PARAMETER | (close & (TYPE_QUERY_ARGUMENT_GROUP | TYPE_GROUP_FORMAL_BINDING)) : close};
    bool result = false;
    bool slot_named = true, slot_annotation = false;
    bool first_operand = close != UNTYPED_PARAMETER_GROUP_END, operand_pending = false, query_operand = false, parameter_position = close != TYPE_SUBSTITUTION_GROUP_END, member_line_break = false;
    if (type_operands && close == '}' && lexer->lookahead == '|') {
        stack[0].exact_object = true;
        advance(lexer);
    }
    while (!lexer->eof(lexer)) {
        TypeGroupFrame *group = &stack[size - 1];
        int32_t c = lexer->lookahead, context = group->context;
        bool reference_line_break = group->prefix & TYPE_GROUP_REFERENCE_LINE_BREAK;
        if (!is_whitespace(c) && c != '/') group->prefix &= ~TYPE_GROUP_REFERENCE_LINE_BREAK;
        if (context & TYPE_EXPRESSION_TYPE) {
            if ((context & TYPE_EXPRESSION_METHOD_BODY) && !first_operand && c == '{') {
                stack[size - 1].context &= ~(TYPE_EXPRESSION_TYPE | TYPE_EXPRESSION_METHOD_BODY);
                stack[size - 1].context |= TYPE_EXPRESSION_BODY;
            } else if (((context & TYPE_GROUP_ROLE_MASK) == METHOD_PARAMETER_GROUP_END || (context & TYPE_GROUP_ROLE_MASK) == FUNCTION_PARAMETER_GROUP_END) && c == ',') {
                stack[size - 1].context &= ~TYPE_EXPRESSION_TYPE;
            }
            context = stack[size - 1].context;
        }
        int32_t frame = context & TYPE_EXPRESSION_TYPE ? context & TYPE_GROUP_ROLE_MASK : context & ~(TYPE_GROUP_PARAMETER | TYPE_QUERY_ARGUMENT_GROUP | TYPE_GROUP_FORMAL_BINDING);
        int32_t end = frame & TYPE_GROUP_END_MASK, push = 0;
        bool exact_object = false, optional_chain_dot = false;
        bool constructor_header = group->nonreference_type && (group->prefix & TYPE_GROUP_CONSTRUCTOR_PREFIX) && c == '=';
        TypePredicateSubject previous_predicate_subject = group->predicate_subject;
        unsigned previous_parameter_pattern = group->parameter_pattern & TYPE_PARAMETER_PATTERN_MASK;
        bool completed_rest_default = group->default_parameter && (group->parameter_pattern & TYPE_PARAMETER_PATTERN_REST_SLOT) && previous_parameter_pattern == TYPE_PARAMETER_PATTERN_NAME && !group->conditional_depth;
        if (close == UNTYPED_PARAMETER_GROUP_END && size == 1 && slot_named && !slot_annotation &&
            (is_identifier_part(c) || c == '\\')) break;
        if (close == UNTYPED_PARAMETER_GROUP_END && size == 1 && !slot_named) {
            if (c == ',') break;
            if (c != ')' && c != '/' && !is_whitespace(c)) {
                if (c == '.') {
                    unsigned dots = 0;
                    while (dots < 3 && lexer->lookahead == '.') {
                        advance(lexer);
                        dots++;
                    }
                    if (dots != 3 || !scan_default_trivia(lexer, true, false)) break;
                    if (lexer->lookahead != '[' && lexer->lookahead != '{' && !scan_type_identifier_operand(lexer)) break;
                    slot_named = true;
                    continue;
                }
                if ((is_identifier_part(c) && !is_ascii_digit(c)) || c == '\\') {
                    if (!scan_type_identifier_operand(lexer)) break;
                    slot_named = true;
                    continue;
                }
                if (c == '[' || c == '{') slot_named = true;
                else break;
            }
        }
        bool completed_parenthesized_operand = group->prefix & TYPE_GROUP_PARENTHESIZED_HEADER;
        if (!is_whitespace(c) && c != '/') group->prefix &= ~TYPE_GROUP_PARENTHESIZED_HEADER;
        bool check_type_operands = type_operands && !(frame & TYPE_EXPRESSION_GROUP);
        bool check_expression_operands = type_operands && (frame & TYPE_EXPRESSION_GROUP);
        bool computed_expression = check_type_operands && frame == COMPUTED_PROPERTY_GROUP_END && parameter_position;
        bool parameter_pattern_position = complete_conditionals && check_type_operands && !group->default_value &&
            ((parameter_position && ((end == ')' && (((context & TYPE_GROUP_PARAMETER) && group->return_owner == TYPE_RETURN_NONE) || frame == FUNCTION_PARAMETER_GROUP_END || frame == METHOD_PARAMETER_GROUP_END)) || frame == ']')) || (frame == OBJECT_PROPERTY_GROUP_END && (group->binding_type || (group->parameter_pattern & TYPE_PARAMETER_PATTERN_REST_SLOT)) && !is_query_argument_expression(stack, size)));
        bool formal_binding_owner = ((context & TYPE_GROUP_FORMAL_BINDING) || (group->parameter_pattern & TYPE_PARAMETER_PATTERN_REST_SLOT) || frame == FUNCTION_PARAMETER_GROUP_END || frame == METHOD_PARAMETER_GROUP_END) &&
            (parameter_position || (frame == OBJECT_PROPERTY_GROUP_END && group->binding_type));
        bool ambiguous_parameter_context = parameter_pattern_position && (context & TYPE_GROUP_PARAMETER) && !formal_binding_owner;
        if (complete_conditionals && check_type_operands && !group->default_value &&
            !computed_expression && (frame != OBJECT_PROPERTY_GROUP_END || group->binding_type) &&
            !is_query_argument_expression(stack, size) && unsafe_conditional &&
            ((query_operand && !is_whitespace(c) && c != '/' && (!is_identifier_part(c) || is_ascii_digit(c))) ||
             (group->infer_name && starts_non_identifier_type_operand(c)))) *unsafe_conditional = true;
        if (complete_conditionals && check_type_operands && !group->default_value && !computed_expression &&
            (group->prefix & TYPE_GROUP_UNIQUE_PREFIX) && !(group->prefix & TYPE_GROUP_ASSERTION_SUBJECT) && !is_whitespace(c) && c != '/' && !is_identifier_part(c) && c != '\\' &&
            (frame == TYPE_OPERAND_GROUP_END || frame == '>' || (frame == ']' && !(context & TYPE_GROUP_PARAMETER)) || (frame == OBJECT_PROPERTY_GROUP_END && group->binding_type) ||
             ((frame == FUNCTION_PARAMETER_GROUP_END || frame == METHOD_PARAMETER_GROUP_END) && !parameter_position)) &&
            !(parameter_position && end == ')' && (c == ')' || c == ',' || c == ':' || c == '?' || c == '=')) &&
            !is_query_argument_expression(stack, size)) {
            if (frame == TYPE_OPERAND_GROUP_END && parameter_position && (context & TYPE_GROUP_PARAMETER) && group->return_owner == TYPE_RETURN_NONE) { group->expression_only = true; group->parameter_header = true; }
            else if (unsafe_conditional) *unsafe_conditional = true;
        }
        if (complete_conditionals && check_type_operands && (group->prefix & TYPE_GROUP_IMPORT_QUERY_PREFIX) &&
            !(group->prefix & TYPE_GROUP_MEMBER_QUERY_PREFIX) && !is_whitespace(c) && c != '/') {
            if (c != '(') {
                if (c != '<' && unsafe_conditional) *unsafe_conditional = true;
                group->prefix &= ~TYPE_GROUP_IMPORT_QUERY_PREFIX;
            }
        }
        if (complete_conditionals && check_type_operands && group->nonreference_type && !is_whitespace(c) && c != '/') {
            if (unsafe_conditional && (((group->prefix & TYPE_GROUP_PRIMARY_PREFIX) && c == '=') ||
                ((group->prefix & TYPE_GROUP_CONSTRUCTOR_PREFIX) && c != '='))) *unsafe_conditional = true;
            if (unsafe_conditional && (c == '|' || c == '&') &&
                (group->prefix & (TYPE_GROUP_IMPORT_QUERY_PREFIX | TYPE_GROUP_MEMBER_QUERY_PREFIX)) == (TYPE_GROUP_IMPORT_QUERY_PREFIX | TYPE_GROUP_MEMBER_QUERY_PREFIX) &&
                ((frame == TYPE_OPERAND_GROUP_END && (context & TYPE_GROUP_PARAMETER) && group->return_owner == TYPE_RETURN_NONE) || (frame == OBJECT_PROPERTY_GROUP_END && group->binding_type)) &&
                !is_query_argument_expression(stack, size)) *unsafe_conditional = true;
            bool query_call = group->prefix & TYPE_GROUP_MEMBER_QUERY_PREFIX;
            if ((group->prefix & TYPE_GROUP_IMPORT_QUERY_PREFIX) && (c == '.' || c == '[') && frame != OBJECT_PROPERTY_GROUP_END && unsafe_conditional) *unsafe_conditional = true;
            group->prefix = c == end ? group->prefix & (TYPE_GROUP_IMPORT_QUERY_PREFIX | TYPE_GROUP_MEMBER_QUERY_PREFIX) : TYPE_GROUP_NO_PREFIX;
            if ((c == '<' || c == '(' || (c == '.' && !query_call)) && unsafe_conditional) *unsafe_conditional = true;
            if (c != '[') group->nonreference_type = false;
        }
        if (end == '\'' || end == '"' || end == '`') {
            advance(lexer);
            if (c == end) {
                size--;
                if ((frame & ~TYPE_GROUP_END_MASK) == PROPERTY_NAME_GROUP) parameter_position = true;
                else if (complete_conditionals && check_type_operands && !group->default_value && size > 0 &&
                         (stack[size - 1].context & TYPE_GROUP_ROLE_MASK) != COMPUTED_PROPERTY_GROUP_END) {
                    if ((stack[size - 1].prefix & (TYPE_GROUP_CONSTRUCTOR_PREFIX | TYPE_GROUP_ABSTRACT_PREFIX)) && unsafe_conditional) *unsafe_conditional = true;
                    stack[size - 1].prefix = TYPE_GROUP_NO_PREFIX;
                    stack[size - 1].nonreference_type = true;
                }
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
                group->binding_type = false;
                member_line_break = false;
            }
            if (((check_type_operands && (operand_pending || (first_operand && frame == COMPUTED_PROPERTY_GROUP_END && !parameter_position))) || (check_expression_operands && (frame & TYPE_EXPRESSION_OPERAND))) && c == '\\') {
                if (complete_conditionals && group->default_value && !group->default_type && (group->prefix & TYPE_GROUP_DEFAULT_IDENTIFIER) && unsafe_conditional) *unsafe_conditional = true;
                if (!scan_type_identifier_operand(lexer)) break;
                if (group->default_value) group->prefix &= ~TYPE_GROUP_DEFAULT_IDENTIFIER;
                stack[size - 1].context &= ~(TYPE_EXPRESSION_OPERAND | TYPE_EXPRESSION_PROPERTY | TYPE_EXPRESSION_EMPTY_GROUP | TYPE_EXPRESSION_BODY);
                operand_pending = false;
                first_operand = false;
                query_operand = false;
                if (complete_conditionals && check_type_operands) group->operand_required = false;
                if (complete_conditionals && check_type_operands && !group->default_value) {
                    if ((group->prefix & (TYPE_GROUP_CONSTRUCTOR_PREFIX | TYPE_GROUP_ABSTRACT_PREFIX)) && unsafe_conditional) *unsafe_conditional = true;
                    group->prefix = TYPE_GROUP_NO_PREFIX;
                    group->nonreference_type = group->infer_name;
                    group->infer_constraint = group->infer_name;
                    group->infer_name = false;
                    group->property = false;
                    if (!computed_expression && !is_query_argument_expression(stack, size)) group->predicate_subject = previous_predicate_subject == TYPE_PREDICATE_SUBJECT_NONE ? TYPE_PREDICATE_SUBJECT_NAME : TYPE_PREDICATE_SUBJECT_COMPOSED;
                }
                continue;
            }
            if (check_type_operands && is_identifier_part(c)) {
                char word[16] = {0};
                bool ascii_word = false;
                bool object_member_name = frame == OBJECT_PROPERTY_GROUP_END && parameter_position;
                if (complete_conditionals && !group->default_value && !computed_expression && is_ascii_digit(c)) {
                    if (!scan_type_numeric_operand(lexer)) break;
                    if (!object_member_name && !query_operand && is_identifier_part(lexer->lookahead) && unsafe_conditional) *unsafe_conditional = true;
                } else ascii_word = scan_identifier(lexer, word, sizeof(word), false);
                if (complete_conditionals && frame == TYPE_OPERAND_GROUP_END && parameter_position && first_operand && group->prefix == TYPE_GROUP_NO_PREFIX &&
                    !group->property && !query_operand && !group->default_value && ascii_word &&
                    is_type_probe_word(word, TS_PARAMETER_HEADER_KEYWORDS, sizeof(TS_PARAMETER_HEADER_KEYWORDS) / sizeof(TS_PARAMETER_HEADER_KEYWORDS[0]))) {
                    group->parameter_header = true;
                }
                if (complete_conditionals && frame == TYPE_OPERAND_GROUP_END && !group->default_value && !computed_expression &&
                    !group->property && !query_operand && ascii_word) {
                    if ((group->prefix & TYPE_GROUP_ASSERTS_PREFIX) && parameter_position) group->expression_only = true;
                    if ((group->prefix & TYPE_GROUP_ASSERTION_PREDICATE) && strcmp(word, "is") != 0) group->expression_only = true;
                }
                TypePredicateSubject previous_subject = group->predicate_subject;
                bool predicate_word = ascii_word && strcmp(word, "is") == 0 && !group->property && !query_operand && previous_subject != TYPE_PREDICATE_SUBJECT_NONE;
                bool unique_completion = ascii_word && strcmp(word, "symbol") == 0 && (group->prefix & TYPE_GROUP_UNIQUE_PREFIX) && previous_subject == TYPE_PREDICATE_SUBJECT_NAME && !group->property && !query_operand;
                bool assertion_unique_completion = unique_completion && (group->prefix & TYPE_GROUP_ASSERTION_SUBJECT);
                if (complete_conditionals && !group->default_value && !computed_expression && (frame == '>' || (frame == ']' && !(context & TYPE_GROUP_PARAMETER))) &&
                    (group->prefix & TYPE_GROUP_UNIQUE_PREFIX) && !unique_completion && !predicate_word && !is_query_argument_expression(stack, size) && unsafe_conditional) *unsafe_conditional = true;
                bool assertion_subject = (group->prefix & TYPE_GROUP_ASSERTS_PREFIX) && !object_member_name && !query_operand && !group->property;
                bool assertion_is = assertion_subject && ascii_word && strcmp(word, "is") == 0;
                if (complete_conditionals && !group->default_value && !computed_expression && (!object_member_name || (frame == OBJECT_PROPERTY_GROUP_END && group->binding_type)) && !is_query_argument_expression(stack, size)) {
                    if (predicate_word && previous_subject != TYPE_PREDICATE_SUBJECT_NAME && unsafe_conditional) *unsafe_conditional = true;
                    if ((group->prefix & TYPE_GROUP_ASSERTION_SUBJECT) && !unique_completion && !(ascii_word && strcmp(word, "is") == 0) && unsafe_conditional) *unsafe_conditional = true;
                    group->predicate_subject = predicate_word ? TYPE_PREDICATE_SUBJECT_NONE :
                        is_type_predicate_name_word(c, word, ascii_word) && !group->property && !query_operand &&
                        (previous_subject == TYPE_PREDICATE_SUBJECT_NONE || assertion_subject || unique_completion) ? TYPE_PREDICATE_SUBJECT_NAME : TYPE_PREDICATE_SUBJECT_COMPOSED;
                }
                if (complete_conditionals && frame == TYPE_OPERAND_GROUP_END && parameter_position && !group->default_value && !query_operand && ascii_word && strcmp(word, "is") == 0 && (previous_parameter_pattern == TYPE_PARAMETER_PATTERN_NON_PATTERN || previous_parameter_pattern == TYPE_PARAMETER_PATTERN_INVALID || (group->parameter_pattern & TYPE_PARAMETER_PATTERN_INVALID_SLOT))) group->expression_only = true;
                bool assertion_predicate = (group->prefix & TYPE_GROUP_ASSERTS_PREFIX) && ascii_word &&
                    is_type_probe_word(word, TS_ASSERTION_PREDICATE_SUBJECT_KEYWORDS, sizeof(TS_ASSERTION_PREDICATE_SUBJECT_KEYWORDS) / sizeof(TS_ASSERTION_PREDICATE_SUBJECT_KEYWORDS[0]));
                if (complete_conditionals && check_type_operands && !group->default_value && (end == ')' || frame == ']') && group->property && previous_parameter_pattern == TYPE_PARAMETER_PATTERN_NAME && !is_query_argument_expression(stack, size)) group->parameter_header = true;
                if (parameter_pattern_position && !group->property) {
                    bool ambiguous_parameter_owner = ambiguous_parameter_context && !is_query_argument_expression(stack, size);
                    unsigned pattern = group->parameter_pattern & TYPE_PARAMETER_PATTERN_MASK;
                    bool modifier = ascii_word && (strcmp(word, "public") == 0 || strcmp(word, "private") == 0 || strcmp(word, "protected") == 0 || strcmp(word, "override") == 0 || strcmp(word, "readonly") == 0);
                    if (pattern == TYPE_PARAMETER_PATTERN_NAME || pattern == TYPE_PARAMETER_PATTERN_NON_PATTERN || pattern == TYPE_PARAMETER_PATTERN_TYPE_ONLY_NON_PATTERN || pattern == TYPE_PARAMETER_PATTERN_INVALID || pattern == TYPE_PARAMETER_PATTERN_TYPE_ONLY || pattern == TYPE_PARAMETER_PATTERN_PUNCTUATED_NAME || pattern == TYPE_PARAMETER_PATTERN_MEMBER_NAME) pattern = TYPE_PARAMETER_PATTERN_INVALID;
                    else if (modifier) pattern = TYPE_PARAMETER_PATTERN_MODIFIER;
                    else if (ascii_word && ambiguous_parameter_owner && !(group->parameter_pattern & TYPE_PARAMETER_PATTERN_REST_SLOT) &&
                        (strcmp(word, "unique") == 0 || (is_type_probe_word(word, TS_TYPE_ONLY_ATOM_KEYWORDS, sizeof(TS_TYPE_ONLY_ATOM_KEYWORDS) / sizeof(TS_TYPE_ONLY_ATOM_KEYWORDS[0])) && !is_type_probe_word(word, TS_NON_PARAMETER_PATTERN_KEYWORDS, sizeof(TS_NON_PARAMETER_PATTERN_KEYWORDS) / sizeof(TS_NON_PARAMETER_PATTERN_KEYWORDS[0]))))) {
                        pattern = TYPE_PARAMETER_PATTERN_TYPE_ONLY;
                        if (frame == ']' || frame == OBJECT_PROPERTY_GROUP_END) group->parameter_pattern |= TYPE_PARAMETER_PATTERN_INVALID_SLOT;
                    }
                    else if (ascii_word && ambiguous_parameter_owner && !(group->parameter_pattern & TYPE_PARAMETER_PATTERN_REST_SLOT) && strcmp(word, "this") != 0 && is_nonreference_type_word(word) && !is_type_probe_word(word, TS_NON_PARAMETER_PATTERN_KEYWORDS, sizeof(TS_NON_PARAMETER_PATTERN_KEYWORDS) / sizeof(TS_NON_PARAMETER_PATTERN_KEYWORDS[0]))) pattern = TYPE_PARAMETER_PATTERN_PUNCTUATED_NAME;
                    else if (ascii_word && ambiguous_parameter_owner && frame == OBJECT_PROPERTY_GROUP_END && strcmp(word, "this") == 0) pattern = TYPE_PARAMETER_PATTERN_MEMBER_NAME;
                    else if (frame == ']' && ascii_word && is_type_probe_word(word, TS_TYPE_ONLY_ATOM_KEYWORDS, sizeof(TS_TYPE_ONLY_ATOM_KEYWORDS) / sizeof(TS_TYPE_ONLY_ATOM_KEYWORDS[0]))) pattern = is_type_probe_word(word, TS_NON_PARAMETER_PATTERN_KEYWORDS, sizeof(TS_NON_PARAMETER_PATTERN_KEYWORDS) / sizeof(TS_NON_PARAMETER_PATTERN_KEYWORDS[0])) ? TYPE_PARAMETER_PATTERN_TYPE_ONLY_NON_PATTERN : TYPE_PARAMETER_PATTERN_TYPE_ONLY;
                    else pattern = is_ascii_digit(c) || (ascii_word && (is_type_probe_word(word, TS_NON_PARAMETER_PATTERN_KEYWORDS, sizeof(TS_NON_PARAMETER_PATTERN_KEYWORDS) / sizeof(TS_NON_PARAMETER_PATTERN_KEYWORDS[0])) || ((frame == ']' || frame == OBJECT_PROPERTY_GROUP_END || (group->parameter_pattern & TYPE_PARAMETER_PATTERN_REST_SLOT)) && strcmp(word, "this") == 0))) ? TYPE_PARAMETER_PATTERN_NON_PATTERN : TYPE_PARAMETER_PATTERN_NAME;
                    group->parameter_pattern = (group->parameter_pattern & (TYPE_PARAMETER_PATTERN_INVALID_SLOT | TYPE_PARAMETER_PATTERN_OBJECT_CANDIDATE | TYPE_PARAMETER_PATTERN_ANNOTATABLE_OBJECT | TYPE_PARAMETER_PATTERN_REST_SLOT)) | pattern;
                }
                bool type_operator = ascii_word && (strcmp(word, "typeof") == 0 || strcmp(word, "keyof") == 0 || strcmp(word, "readonly") == 0 || strcmp(word, "infer") == 0);
                bool parenthesized_query = complete_conditionals && query_operand && frame == TYPE_OPERAND_GROUP_END && parameter_position &&
                    !(group->prefix & TYPE_GROUP_TYPE_PREFIX) && !group->default_value && !computed_expression && !object_member_name;
                bool object_query = complete_conditionals && query_operand && frame == OBJECT_PROPERTY_GROUP_END && group->binding_type && !parameter_position && !group->default_value && !is_query_argument_expression(stack, size);
                bool ambiguous_object_query = object_query && group->object_query_owner == TYPE_OBJECT_QUERY_PARENTHESIZED;
                if ((parenthesized_query || ambiguous_object_query) && ascii_word && unsafe_conditional && is_type_probe_word(word, TS_NON_IDENTIFIER_QUERY_KEYWORDS, sizeof(TS_NON_IDENTIFIER_QUERY_KEYWORDS) / sizeof(TS_NON_IDENTIFIER_QUERY_KEYWORDS[0]))) *unsafe_conditional = true;
                if (complete_conditionals && frame == TYPE_OPERAND_GROUP_END && !group->default_value && !computed_expression &&
                    !group->property && !query_operand && ascii_word) {
                    bool ambiguous_start = first_operand && parameter_position && !(group->prefix & (TYPE_GROUP_PRIMARY_PREFIX | TYPE_GROUP_TYPE_PREFIX | TYPE_GROUP_PREDICATE_PREFIX | TYPE_GROUP_CONSTRUCTOR_PREFIX | TYPE_GROUP_ABSTRACT_PREFIX));
                    if ((ambiguous_start && ((group->prefix & TYPE_GROUP_READONLY_PREFIX) || is_type_probe_word(word, TS_NON_IDENTIFIER_QUERY_KEYWORDS, sizeof(TS_NON_IDENTIFIER_QUERY_KEYWORDS) / sizeof(TS_NON_IDENTIFIER_QUERY_KEYWORDS[0]))) && is_type_probe_word(word, TS_EXPRESSION_ONLY_TYPE_KEYWORDS, sizeof(TS_EXPRESSION_ONLY_TYPE_KEYWORDS) / sizeof(TS_EXPRESSION_ONLY_TYPE_KEYWORDS[0]))) ||
                        ((group->prefix & TYPE_GROUP_ASSERTS_PREFIX) && is_type_probe_word(word, TS_NON_ASSERTION_IDENTIFIER_KEYWORDS, sizeof(TS_NON_ASSERTION_IDENTIFIER_KEYWORDS) / sizeof(TS_NON_ASSERTION_IDENTIFIER_KEYWORDS[0])))) group->expression_only = true;
                }
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
                if (complete_conditionals && frame == TYPE_OPERAND_GROUP_END && !group->default_value &&
                    !computed_expression && !group->property && !query_operand && !first_operand && !operand_pending &&
                    !(ascii_word && (strcmp(word, "extends") == 0 || strcmp(word, "is") == 0)) &&
                    !(group->prefix & (TYPE_GROUP_ASSERTS_PREFIX | TYPE_GROUP_PREDICATE_PREFIX)) &&
                    !((group->prefix & TYPE_GROUP_UNIQUE_PREFIX) && ascii_word && strcmp(word, "symbol") == 0)) {
                    group->expression_only = true;
                }
                if (complete_conditionals && !group->default_value && !computed_expression && !object_member_name) {
                    bool predicate = ascii_word && strcmp(word, "is") == 0 && !group->property && !query_operand && !first_operand && (!(group->prefix & TYPE_GROUP_ASSERTS_PREFIX) || assertion_is);
                    if (group->return_owner != TYPE_RETURN_FUNCTION && ((predicate && !operand_pending) || assertion_subject ||
                        ((group->prefix & TYPE_GROUP_PREDICATE_PREFIX) && previous_subject == TYPE_PREDICATE_SUBJECT_NONE && !(ascii_word && strcmp(word, "extends") == 0))) &&
                        !is_query_argument_expression(stack, size) && unsafe_conditional) *unsafe_conditional = true;
                    bool predicate_operator = (group->prefix & TYPE_GROUP_PREDICATE_PREFIX) && (type_operator || (ascii_word && strcmp(word, "unique") == 0));
                    group->prefix = (predicate || predicate_operator) ? TYPE_GROUP_PREDICATE_PREFIX : update_type_group_prefix(group->prefix, ascii_word ? word : "", (first_operand || ((group->prefix & TYPE_GROUP_PREDICATE_PREFIX) && previous_subject == TYPE_PREDICATE_SUBJECT_NONE && ascii_word && strcmp(word, "new") == 0)) && !group->property && !query_operand, unsafe_conditional);
                }
                if (assertion_subject && !assertion_is) group->prefix = TYPE_GROUP_ASSERTION_SUBJECT | (assertion_predicate ? TYPE_GROUP_ASSERTION_PREDICATE : 0) | (ascii_word && strcmp(word, "unique") == 0 ? TYPE_GROUP_UNIQUE_PREFIX : 0);
                if (assertion_unique_completion) group->prefix = TYPE_GROUP_ASSERTION_SUBJECT | TYPE_GROUP_ASSERTION_PREDICATE;
                if (complete_conditionals && first_operand && !group->property && !group->default_value && !computed_expression && !object_member_name) {
                    if (!query_operand && frame == TYPE_OPERAND_GROUP_END && ascii_word && strcmp(word, "import") == 0 && unsafe_conditional) *unsafe_conditional = true;
                    group->query_call_operand = ascii_word && (strcmp(word, "typeof") == 0 || strcmp(word, "import") == 0);
                }
                group->nonreference_type = complete_conditionals && !group->default_value && !computed_expression && !query_operand && !object_member_name && !assertion_subject && !assertion_unique_completion && !(predicate_word && previous_subject == TYPE_PREDICATE_SUBJECT_NAME) && !(group->parameter_pattern & TYPE_PARAMETER_PATTERN_REST_SLOT) &&
                    (is_ascii_digit(c) || (!group->property && (group->infer_name || (ascii_word && is_nonreference_type_word(word)))));
                if ((formal_binding_owner || group->property) && parameter_pattern_position && frame == OBJECT_PROPERTY_GROUP_END && (group->parameter_pattern & TYPE_PARAMETER_PATTERN_MASK) == TYPE_PARAMETER_PATTERN_NAME) group->parameter_pattern |= TYPE_PARAMETER_PATTERN_COMPLETED_BINDING;
                if ((parenthesized_query || (complete_conditionals && query_operand && frame == OBJECT_PROPERTY_GROUP_END && group->binding_type && !parameter_position && !group->default_value && !is_query_argument_expression(stack, size))) && ascii_word && strcmp(word, "import") == 0) group->prefix = TYPE_GROUP_IMPORT_QUERY_PREFIX;
                if (complete_conditionals && query_operand && !group->default_value && !computed_expression && !object_member_name && ascii_word && strcmp(word, "this") == 0) {
                    group->nonreference_type = true;
                    group->prefix = TYPE_GROUP_MEMBER_QUERY_PREFIX;
                }
                bool default_operator = ascii_word && (strcmp(word, "as") == 0 || strcmp(word, "satisfies") == 0 || strcmp(word, "in") == 0 || strcmp(word, "instanceof") == 0);
                bool default_identifier = complete_conditionals && group->default_value && !group->default_type && !group->property && !object_member_name && !default_operator &&
                    !(parameter_position && (frame == FUNCTION_PARAMETER_GROUP_END || frame == METHOD_PARAMETER_GROUP_END)) && first_operand &&
                    !(ascii_word && is_type_probe_word(word, TS_EXPRESSION_PREFIX_KEYWORDS, sizeof(TS_EXPRESSION_PREFIX_KEYWORDS) / sizeof(TS_EXPRESSION_PREFIX_KEYWORDS[0])));
                if (complete_conditionals && group->default_value && !group->default_type && (group->prefix & TYPE_GROUP_DEFAULT_IDENTIFIER) &&
                    !default_operator && unsafe_conditional) *unsafe_conditional = true;
                if (group->default_value) group->prefix = default_identifier ? TYPE_GROUP_DEFAULT_IDENTIFIER : TYPE_GROUP_NO_PREFIX;
                if (group->default_parameter && (group->parameter_pattern & TYPE_PARAMETER_PATTERN_REST_SLOT)) {
                    bool pending = default_operator || (first_operand && ascii_word && (type_operator || is_type_probe_word(word, TS_EXPRESSION_PREFIX_KEYWORDS, sizeof(TS_EXPRESSION_PREFIX_KEYWORDS) / sizeof(TS_EXPRESSION_PREFIX_KEYWORDS[0]))));
                    group->parameter_pattern = (group->parameter_pattern & ~TYPE_PARAMETER_PATTERN_MASK) | (pending ? TYPE_PARAMETER_PATTERN_NONE : TYPE_PARAMETER_PATTERN_NAME);
                }
                bool default_member = complete_conditionals && group->default_value && group->property;
                bool default_assertion = complete_conditionals && group->default_value && !group->property &&
                    !(frame == OBJECT_PROPERTY_GROUP_END && parameter_position) && ascii_word &&
                    (strcmp(word, "as") == 0 || strcmp(word, "satisfies") == 0);
                if (complete_conditionals && group->default_value) {
                    group->operand_required = false;
                    bool member_name = frame == OBJECT_PROPERTY_GROUP_END && parameter_position;
                    if (!group->property && !member_name && ascii_word && strcmp(word, "extends") == 0 &&
                        !group->default_declaration_header && !group->default_type && end != '>') break;
                    if (!group->property && !member_name && ascii_word && (strcmp(word, "class") == 0 || strcmp(word, "function") == 0)) {
                        group->default_declaration_header = true;
                    }
                    if (default_assertion) group->default_type = true;
                    if (group->default_type || end == '>') {
                        if (!group->property && ascii_word && strcmp(word, "extends") == 0 &&
                            !group->default_declaration_header && !group->infer_constraint &&
                            !(parameter_position && (frame == TYPE_PARAMETER_GROUP_END || frame == METHOD_TYPE_PARAMETER_GROUP_END))) {
                            group->question_pending = true;
                        }
                        group->infer_constraint = group->infer_name;
                        group->infer_name = !group->property && ascii_word && strcmp(word, "infer") == 0;
                    }
                    group->property = false;
                }
                bool computed_key = frame == COMPUTED_PROPERTY_GROUP_END && parameter_position;
                if (computed_key && !first_operand && !(ascii_word && strcmp(word, "in") == 0)) {
                    stack[size - 1].context |= TYPE_EXPRESSION_GROUP;
                    if (ascii_word && strcmp(word, "instanceof") == 0) stack[size - 1].context |= TYPE_EXPRESSION_OPERAND;
                }
                bool mapped_operand = frame == COMPUTED_PROPERTY_GROUP_END && ascii_word &&
                    ((strcmp(word, "in") == 0 && parameter_position && (!first_operand || operand_pending)) ||
                     (strcmp(word, "as") == 0 && !parameter_position && !first_operand && !operand_pending));
                bool prefix = !computed_key && !default_member && first_operand && type_operator;
                if (complete_conditionals && group->default_value && group->default_type) {
                    group->operand_required = prefix || (!default_member && first_operand && ascii_word &&
                        (strcmp(word, "new") == 0 || strcmp(word, "import") == 0 || strcmp(word, "unique") == 0));
                }
                bool extends_operand = !computed_key && !default_member && ascii_word && strcmp(word, "extends") == 0 &&
                    (!complete_conditionals || (!first_operand && !operand_pending && !group->property));
                if (complete_conditionals && !group->default_value) {
                    group->operand_required = prefix || extends_operand || mapped_operand ||
                        (!computed_key && !group->property && first_operand && ascii_word &&
                         (strcmp(word, "new") == 0 || strcmp(word, "import") == 0));
                    bool constraint_position = parameter_position && (frame == TYPE_PARAMETER_GROUP_END || frame == METHOD_TYPE_PARAMETER_GROUP_END);
                    if (extends_operand && !constraint_position) {
                        if (group->infer_constraint) group->conditional_candidate = true;
                        else group->question_pending = true;
                    }
                    group->infer_constraint = group->infer_name;
                    group->infer_name = prefix && strcmp(word, "infer") == 0;
                    group->property = false;
                }
                operand_pending = prefix;
                query_operand = prefix && strcmp(word, "typeof") == 0;
                first_operand = default_assertion || (prefix && !query_operand && strcmp(word, "infer") != 0) || extends_operand || mapped_operand || (!computed_key && first_operand && ascii_word && (strcmp(word, "new") == 0 || strcmp(word, "abstract") == 0));
                if (extends_operand || mapped_operand) {
                    parameter_position = false;
                    if (frame == TYPE_OPERAND_GROUP_END) stack[size - 1].context &= ~TYPE_GROUP_PARAMETER;
                }
                continue;
            }
            if (check_expression_operands && is_identifier_part(c)) {
                char word[16] = {0};
                bool ascii_word = scan_identifier(lexer, word, sizeof(word), false);
                bool expression_prefix = !(frame & TYPE_EXPRESSION_PROPERTY) && ascii_word &&
                    (strcmp(word, "in") == 0 || strcmp(word, "instanceof") == 0 || strcmp(word, "typeof") == 0 || strcmp(word, "new") == 0 || strcmp(word, "void") == 0 || strcmp(word, "delete") == 0);
                bool member_name = (frame & TYPE_GROUP_ROLE_MASK) == OBJECT_PROPERTY_GROUP_END && (frame & TYPE_EXPRESSION_PROPERTY);
                stack[size - 1].context &= ~(TYPE_EXPRESSION_OPERAND | TYPE_EXPRESSION_EMPTY_GROUP | TYPE_EXPRESSION_BODY);
                if (!member_name) stack[size - 1].context &= ~TYPE_EXPRESSION_PROPERTY;
                if (!(frame & TYPE_EXPRESSION_PROPERTY) && ascii_word && strcmp(word, "function") == 0) stack[size - 1].context |= TYPE_EXPRESSION_FUNCTION;
                if (expression_prefix) stack[size - 1].context |= TYPE_EXPRESSION_OPERAND;
                first_operand = expression_prefix;
                operand_pending = false;
                query_operand = false;
                continue;
            }
            if (c == '/') {
                bool comment = false;
                CommentResult comment_result = skip_comment(lexer, &comment, false);
                if (comment_result == NO_COMMENT) break;
                if (comment_result == COMMENT_WITH_LINE_TERMINATOR) group->prefix |= TYPE_GROUP_REFERENCE_LINE_BREAK;
                if (comment_result == COMMENT_WITH_LINE_TERMINATOR && frame == OBJECT_PROPERTY_GROUP_END && !first_operand && !operand_pending) {
                    member_line_break = true;
                }
                continue;
            }
            if (is_line_terminator(c)) group->prefix |= TYPE_GROUP_REFERENCE_LINE_BREAK;
            if (is_line_terminator(c) && frame == OBJECT_PROPERTY_GROUP_END && !first_operand && !operand_pending) {
                member_line_break = true;
            }
            if (complete_conditionals && group->default_value && !group->default_type && !is_whitespace(c)) {
                if (c == '\\' && (group->prefix & TYPE_GROUP_DEFAULT_IDENTIFIER) && unsafe_conditional) *unsafe_conditional = true;
                group->prefix &= ~TYPE_GROUP_DEFAULT_IDENTIFIER;
            }
            if (complete_conditionals && group->default_value && !computed_expression &&
                (c == end || c == ',' || c == ';') &&
                (group->question_pending || group->conditional_depth ||
                 (group->conditional_branch && first_operand) ||
                 (group->default_parameter && group->operand_required))) break;
            if (complete_conditionals && group->default_value && !is_whitespace(c)) {
                if (c == ':' && parameter_position && end == ')' && !group->conditional_depth) group->default_type = true;
                if (c == ':' && group->conditional_depth) {
                    if (first_operand) break;
                    group->conditional_depth--;
                }
                if (c == ',' || c == ';') group->conditional_branch = false;
                if (c == ',' && (frame == FUNCTION_PARAMETER_GROUP_END || frame == METHOD_PARAMETER_GROUP_END)) group->default_type = false;
                group->property = c == '.';
                if (c == '{') {
                    if (group->default_declaration_header || !first_operand) group->default_type = false;
                    group->default_declaration_header = false;
                }
            }
            if (complete_conditionals && check_type_operands && !group->default_value && !is_whitespace(c) &&
                (group->prefix & (TYPE_GROUP_ASSERTION_PREDICATE | TYPE_GROUP_CONSTRUCTOR_PREFIX)) &&
                ((group->prefix & TYPE_GROUP_ASSERTION_PREDICATE) || c == '.' || (group->return_owner == TYPE_RETURN_FUNCTION && (c == end || c == ',' || c == ';'))) && unsafe_conditional) *unsafe_conditional = true;
            if (complete_conditionals && check_type_operands && !group->default_value && !is_query_argument_expression(stack, size) &&
                (group->prefix & TYPE_GROUP_ASSERTION_SUBJECT) && (c == '<' || c == '(' || c == '[' || c == '.' || c == '{') && unsafe_conditional) *unsafe_conditional = true;
            if (complete_conditionals && check_type_operands && frame == TYPE_OPERAND_GROUP_END && reference_line_break && c == '<' &&
                !first_operand && !operand_pending && !group->default_value && !group->query_call_operand && !is_query_argument_expression(stack, size) && unsafe_conditional) *unsafe_conditional = true;
            if (complete_conditionals && check_type_operands && frame == TYPE_OPERAND_GROUP_END && group->return_owner == TYPE_RETURN_FUNCTION &&
                !group->default_value && !is_query_argument_expression(stack, size) && (group->prefix & TYPE_GROUP_ASSERTS_PREFIX) && group->predicate_subject == TYPE_PREDICATE_SUBJECT_NAME &&
                (c == '(' || c == '[' || c == '.' || c == '{') && unsafe_conditional) *unsafe_conditional = true;
            if (complete_conditionals && (end == ')' || frame == ']' || (frame == OBJECT_PROPERTY_GROUP_END && group->binding_type && !is_query_argument_expression(stack, size))) && !group->default_value) {
                unsigned pattern = group->parameter_pattern & TYPE_PARAMETER_PATTERN_MASK;
                if ((group->parameter_pattern & TYPE_PARAMETER_PATTERN_ANNOTATABLE_OBJECT) && !(group->parameter_pattern & TYPE_PARAMETER_PATTERN_OPTIONAL_SLOT) && end == ')' && c == ':') group->parameter_pattern &= ~(TYPE_PARAMETER_PATTERN_OBJECT_CANDIDATE | TYPE_PARAMETER_PATTERN_ANNOTATABLE_OBJECT);
                if ((group->parameter_pattern & TYPE_PARAMETER_PATTERN_OBJECT_CANDIDATE) && (c == ',' || c == '=')) group->parameter_pattern |= TYPE_PARAMETER_PATTERN_INVALID_SLOT;
                if (pattern == TYPE_PARAMETER_PATTERN_MEMBER_NAME && (c == '.' || c == '[')) { pattern = TYPE_PARAMETER_PATTERN_NAME; group->parameter_pattern = (group->parameter_pattern & ~TYPE_PARAMETER_PATTERN_MASK) | pattern; }
                if (pattern == TYPE_PARAMETER_PATTERN_TYPE_ONLY && (c == '.' || c == '[' || c == '=')) group->parameter_pattern |= TYPE_PARAMETER_PATTERN_INVALID_SLOT;
                if (pattern == TYPE_PARAMETER_PATTERN_PUNCTUATED_NAME && (c == '.' || c == '[' || c == '=' || c == ':' || c == '?')) {
                    pattern = frame == ']' && c == '?' ? TYPE_PARAMETER_PATTERN_TYPE_ONLY_NON_PATTERN : TYPE_PARAMETER_PATTERN_NAME;
                    group->parameter_pattern = (group->parameter_pattern & ~TYPE_PARAMETER_PATTERN_MASK) | pattern;
                }
                if (frame == OBJECT_PROPERTY_GROUP_END && group->binding_type && (context & TYPE_GROUP_PARAMETER) && !(context & TYPE_GROUP_FORMAL_BINDING) && c == '[' && (pattern == TYPE_PARAMETER_PATTERN_NON_PATTERN || pattern == TYPE_PARAMETER_PATTERN_TYPE_ONLY_NON_PATTERN)) group->parameter_pattern |= TYPE_PARAMETER_PATTERN_INVALID_SLOT;
                if (frame != OBJECT_PROPERTY_GROUP_END && (c == '.' || c == '[' || c == '(')) group->parameter_pattern &= ~TYPE_PARAMETER_PATTERN_COMPLETED_BINDING;
                if ((c == '.' || (c == '[' && !first_operand)) && (pattern == TYPE_PARAMETER_PATTERN_NON_PATTERN || pattern == TYPE_PARAMETER_PATTERN_TYPE_ONLY_NON_PATTERN)) group->parameter_pattern = (group->parameter_pattern & ~TYPE_PARAMETER_PATTERN_MASK) | TYPE_PARAMETER_PATTERN_NAME;
                if (c == ',' || c == ':' || c == '=') {
                    if (c == '=' && (((group->parameter_pattern & TYPE_PARAMETER_PATTERN_OPTIONAL_SLOT) && !(group->parameter_pattern & TYPE_PARAMETER_PATTERN_COMPLETED_BINDING)) || (frame == ']' && (group->parameter_pattern & TYPE_PARAMETER_PATTERN_REST_SLOT)))) group->parameter_pattern |= TYPE_PARAMETER_PATTERN_INVALID_SLOT;
                    if (c == '=' && first_operand && parameter_position && pattern == TYPE_PARAMETER_PATTERN_NONE) group->parameter_pattern |= TYPE_PARAMETER_PATTERN_INVALID_SLOT;
                    if (pattern == TYPE_PARAMETER_PATTERN_NON_PATTERN || pattern == TYPE_PARAMETER_PATTERN_TYPE_ONLY_NON_PATTERN || pattern == TYPE_PARAMETER_PATTERN_INVALID || pattern == TYPE_PARAMETER_PATTERN_PUNCTUATED_NAME || pattern == TYPE_PARAMETER_PATTERN_MEMBER_NAME) group->parameter_pattern |= TYPE_PARAMETER_PATTERN_INVALID_SLOT;
                    group->parameter_pattern &= TYPE_PARAMETER_PATTERN_ANNOTATABLE_OBJECT | TYPE_PARAMETER_PATTERN_OBJECT_CANDIDATE | TYPE_PARAMETER_PATTERN_INVALID_SLOT | (frame == OBJECT_PROPERTY_GROUP_END ? TYPE_PARAMETER_PATTERN_COMPLETED_BINDING : 0) | (c == '=' ? TYPE_PARAMETER_PATTERN_REST_SLOT | TYPE_PARAMETER_PATTERN_OPTIONAL_SLOT : 0);
                }
            }
            if (complete_conditionals && check_type_operands && frame == ']' && (context & TYPE_GROUP_PARAMETER) &&
                parameter_position && !first_operand && c == '?' && !group->default_value && !group->question_pending && !group->conditional_depth) group->parameter_pattern |= TYPE_PARAMETER_PATTERN_INVALID_SLOT;
            if (complete_conditionals && check_type_operands && frame == ']' && (context & TYPE_GROUP_PARAMETER) &&
                parameter_position && !first_operand && c == '?' && !group->default_value &&
                (group->parameter_pattern & TYPE_PARAMETER_PATTERN_MASK) != TYPE_PARAMETER_PATTERN_TYPE_ONLY &&
                (group->parameter_pattern & TYPE_PARAMETER_PATTERN_MASK) != TYPE_PARAMETER_PATTERN_TYPE_ONLY_NON_PATTERN && !is_query_argument_expression(stack, size)) group->expression_only = true;
            bool binding_frame = parameter_position && (frame == OBJECT_PROPERTY_GROUP_END || frame == COMPUTED_PROPERTY_GROUP_END || frame == TYPE_PARAMETER_GROUP_END || frame == METHOD_TYPE_PARAMETER_GROUP_END || frame == FUNCTION_PARAMETER_GROUP_END || frame == METHOD_PARAMETER_GROUP_END);
            bool completed_name = (parameter_position || (group->parameter_header && !group->default_value && end == ')' && !is_query_argument_expression(stack, size))) &&
                ((frame == OBJECT_PROPERTY_GROUP_END && !group->binding_type && (c == end || c == ',' || c == ';')) ||
                 (end == ')' && (c == end || c == ',' || c == '?') &&
                  (frame == FUNCTION_PARAMETER_GROUP_END || frame == METHOD_PARAMETER_GROUP_END ||
                   (frame == TYPE_OPERAND_GROUP_END && ((context & TYPE_GROUP_PARAMETER) || group->parameter_header)))));
            if (complete_conditionals && frame == ']' && group->expression_only && !group->default_value && group->operand_required &&
                (c == end || c == ',' || c == ';')) {
                if (unsafe_conditional) *unsafe_conditional = true;
                group->operand_required = false;
                group->parameter_pattern |= TYPE_PARAMETER_PATTERN_INVALID_SLOT;
            }
            if (complete_conditionals && check_type_operands && !computed_expression && !group->default_value &&
                (c == end || c == ',' || c == ';') && group->operand_required && !completed_name) break;
            if (complete_conditionals && check_type_operands && !group->default_value && !computed_expression &&
                (c == end || c == ',' || c == ';') && !completed_name && (group->prefix & TYPE_GROUP_UNIQUE_PREFIX) && !(group->prefix & TYPE_GROUP_ASSERTION_SUBJECT) &&
                (frame == TYPE_OPERAND_GROUP_END || frame == '>' || (frame == ']' && !(context & TYPE_GROUP_PARAMETER)) || (frame == OBJECT_PROPERTY_GROUP_END && group->binding_type) ||
                 ((frame == FUNCTION_PARAMETER_GROUP_END || frame == METHOD_PARAMETER_GROUP_END) && !parameter_position)) &&
                !is_query_argument_expression(stack, size) && unsafe_conditional) *unsafe_conditional = true;
            if (complete_conditionals && completed_name && c == '?') group->parameter_pattern |= TYPE_PARAMETER_PATTERN_OPTIONAL_SLOT;
            if (complete_conditionals && completed_name) {
                group->operand_required = false;
                if (c == ',') operand_pending = false;
            }
            if (complete_conditionals && check_type_operands && !group->default_value && !is_whitespace(c)) {
                group->infer_name = false;
                group->infer_constraint = false;
                if ((c == end || c == ',' || c == ';') && (group->question_pending || group->conditional_depth || (group->conditional_branch && (first_operand || group->property)))) break;
                if (c == '?' && group->conditional_candidate) group->question_pending = true;
                if (c == '?' || c == ',' || c == ';') group->conditional_candidate = false;
                if (c == '?' && frame == TYPE_OPERAND_GROUP_END && (!(context & TYPE_GROUP_PARAMETER) || group->return_owner != TYPE_RETURN_NONE) && !group->question_pending && !group->conditional_depth && !is_query_argument_expression(stack, size)) group->expression_only = true;
                if (c == '?' && group->question_pending) {
                    if (first_operand || operand_pending || group->property) break;
                    group->question_pending = false;
                    group->conditional_depth++;
                    group->conditional_branch = true;
                } else if (c == ':' && (!binding_frame || group->conditional_depth)) {
                    if (group->question_pending || (group->conditional_branch && (first_operand || group->property))) break;
                    if (group->conditional_depth) group->conditional_depth--;
                }
                if (c == ',' || c == ';') group->conditional_branch = false;
                group->property = c == '.';
            }
            if (complete_conditionals && !group->default_value && !is_whitespace(c) && c != '/' && c != end && !is_query_argument_expression(stack, size)) group->predicate_subject = (c == ',' || c == ':' || c == ';') ? TYPE_PREDICATE_SUBJECT_NONE : TYPE_PREDICATE_SUBJECT_COMPOSED;
            bool expression_operand = (frame & TYPE_EXPRESSION_OPERAND) != 0;
            bool parameter_default = (parameter_position || (group->parameter_header && !is_query_argument_expression(stack, size))) && end == ')' && c == '=';
            if (complete_conditionals && check_type_operands && !computed_expression && !group->default_value &&
                (frame != OBJECT_PROPERTY_GROUP_END || group->binding_type) && is_type_probe_punctuation(c)) {
                if ((c != '+' && c != '-') || (!first_operand && !operand_pending)) break;
                if ((group->prefix & TYPE_GROUP_ABSTRACT_PREFIX) && frame == TYPE_OPERAND_GROUP_END && !is_query_argument_expression(stack, size)) group->expression_only = true;
                advance(lexer);
                if (!scan_default_trivia(lexer, true, false)) break;
                if (lexer->lookahead == '.') advance(lexer);
                if (!is_ascii_digit(lexer->lookahead)) break;
                continue;
            }
            if (frame == OBJECT_PROPERTY_GROUP_END) {
                if (c == ':' && !group->default_value) { group->binding_type = true; group->parameter_pattern &= ~TYPE_PARAMETER_PATTERN_COMPLETED_BINDING; }
                else if (c == ',' || c == ';') group->binding_type = false;
            }
            if (c == ',' && group->default_parameter) {
                group->parameter_pattern &= TYPE_PARAMETER_PATTERN_INVALID_SLOT;
                group->default_value = false;
                group->default_parameter = false;
                group->default_declaration_header = false;
                group->default_type = false;
            }
            bool consumed_operator = check_type_operands && frame == OBJECT_PROPERTY_GROUP_END && (!complete_conditionals || group->exact_object) && c == '|';
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
                if (frame == TYPE_OPERAND_GROUP_END) stack[size - 1].context = FUNCTION_PARAMETER_GROUP_END;
                first_operand = true;
                operand_pending = false;
                query_operand = false;
                parameter_position = false;
                continue;
            }
            if (check_type_operands && operand_pending && (c == '%' || c == '^' || c == '!' || c == '~' || c == '@' || c == '#' || (c == '=' && !binding_frame && !parameter_default) || (c == '>' && !binding_frame) || c == '|' || c == '&')) break;
            if (check_type_operands && operand_pending && parameter_default && !binding_frame) stack[size - 1].context = FUNCTION_PARAMETER_GROUP_END;
            if (check_type_operands && (context & TYPE_GROUP_PARAMETER) && c == ':' && frame == TYPE_OPERAND_GROUP_END && (!group->default_value || !group->conditional_branch)) stack[size - 1].context = FUNCTION_PARAMETER_GROUP_END;
            bool expression_annotation = check_expression_operands && c == ':' &&
                ((end == ')' && (first_operand || (context & TYPE_GROUP_PARAMETER))) || (context & TYPE_EXPRESSION_METHOD_BODY));
            if (expression_annotation) {
                stack[size - 1].context &= ~TYPE_EXPRESSION_OPERAND;
                stack[size - 1].context |= TYPE_EXPRESSION_TYPE;
            }
            if (complete_conditionals && check_type_operands && !computed_expression && !group->default_value &&
                (frame != OBJECT_PROPERTY_GROUP_END || group->binding_type) && (c == '|' || c == '&' || c == '.')) {
                group->operand_required = true;
            }
            if (!consumed_operator) advance(lexer);
            if (complete_conditionals && completed_rest_default && c == '=' && lexer->lookahead != '=' && lexer->lookahead != '>') group->parameter_pattern |= TYPE_PARAMETER_PATTERN_INVALID_SLOT;
            if (complete_conditionals && group->default_parameter && (group->parameter_pattern & TYPE_PARAMETER_PATTERN_REST_SLOT) && !is_whitespace(c) &&
                c != '.' && c != '[' && !(c == '!' && lexer->lookahead != '=')) group->parameter_pattern &= ~TYPE_PARAMETER_PATTERN_MASK;
            if (complete_conditionals && check_type_operands && frame == TYPE_OPERAND_GROUP_END &&
                (c == '&' || c == '|' || c == '?') && lexer->lookahead == c &&
                !computed_expression && !group->default_value && !is_query_argument_expression(stack, size)) group->expression_only = true;
            if (parameter_pattern_position && end == ')' && (c == '|' || c == '&') && !group->binding_type && !is_query_argument_expression(stack, size)) group->parameter_pattern = TYPE_PARAMETER_PATTERN_INVALID_SLOT | TYPE_PARAMETER_PATTERN_TYPE_ONLY_NON_PATTERN;
            if (complete_conditionals && check_type_operands && frame == ']' && (context & TYPE_GROUP_PARAMETER) && (c == '|' || c == '&') &&
                !group->default_value && !is_query_argument_expression(stack, size)) group->parameter_pattern = (group->parameter_pattern & TYPE_PARAMETER_PATTERN_INVALID_SLOT) | TYPE_PARAMETER_PATTERN_TYPE_ONLY_NON_PATTERN;
            if (complete_conditionals && check_type_operands && frame == ']' && c == '=' && lexer->lookahead != '>' &&
                !group->default_value && !is_query_argument_expression(stack, size)) {
                group->expression_only = true;
                group->operand_required = true;
            }
            if (complete_conditionals && check_type_operands && frame == TYPE_OPERAND_GROUP_END &&
                ((c == '=' && lexer->lookahead != '>') || c == ',') && !computed_expression && !group->default_value &&
                !is_query_argument_expression(stack, size)) {
                group->expression_only = true;
                group->parameter_header = true;
            }
            if (complete_conditionals && group->default_value && c == '?' && !computed_expression &&
                !(lexer->lookahead == ':' && parameter_position &&
                  (binding_frame || (context & TYPE_GROUP_PARAMETER)))) {
                if (lexer->lookahead == '?') advance(lexer);
                else {
                    bool optional_chain = lexer->lookahead == '.';
                    if (optional_chain) {
                        advance(lexer);
                        optional_chain = !is_ascii_digit(lexer->lookahead);
                        group->property = optional_chain;
                        optional_chain_dot = optional_chain;
                    }
                    if (!optional_chain) {
                        group->question_pending = false;
                        group->conditional_depth++;
                        group->conditional_branch = true;
                    }
                }
            }
            if (complete_conditionals && check_type_operands && !group->default_value && frame == OBJECT_PROPERTY_GROUP_END && (context & TYPE_GROUP_PARAMETER) && !group->binding_type && c == '=' && lexer->lookahead != '=' && lexer->lookahead != '>' && !(group->parameter_pattern & TYPE_PARAMETER_PATTERN_INVALID_SLOT)) group->parameter_pattern |= TYPE_PARAMETER_PATTERN_COMPLETED_BINDING;
            if (!group->default_value && lexer->lookahead != '>' &&
                (parameter_default || (check_type_operands && c == '=' &&
                 (frame == FUNCTION_PARAMETER_GROUP_END || frame == METHOD_PARAMETER_GROUP_END)) ||
                 (complete_conditionals && check_type_operands && c == '=' && frame == OBJECT_PROPERTY_GROUP_END && group->binding_type && (previous_parameter_pattern == TYPE_PARAMETER_PATTERN_NAME || previous_parameter_pattern == TYPE_PARAMETER_PATTERN_PUNCTUATED_NAME) && !is_query_argument_expression(stack, size)))) {
                if (complete_conditionals && ((group->operand_required && !parameter_default) ||
                    group->question_pending || group->conditional_depth ||
                    (group->conditional_branch && (first_operand || group->property)))) break;
                if (frame == OBJECT_PROPERTY_GROUP_END && (context & TYPE_GROUP_PARAMETER)) group->parameter_pattern |= TYPE_PARAMETER_PATTERN_COMPLETED_BINDING;
                group->operand_required = complete_conditionals;
                group->conditional_branch = false;
                group->default_value = true;
                group->default_parameter = true;
                group->default_declaration_header = false;
                group->default_type = false;
            }
            if (complete_conditionals && check_type_operands && !computed_expression && !group->default_value && c == '?' &&
                !scan_type_question_tail(lexer, group->conditional_depth != 0)) break;
            if (check_type_operands && frame == TYPE_OPERAND_GROUP_END && (c == '|' || c == '&' || c == '=' || c == '<' || (c == '[' && !first_operand))) stack[size - 1].context &= ~TYPE_GROUP_PARAMETER;
            if (complete_conditionals && check_type_operands && frame == OBJECT_PROPERTY_GROUP_END && (context & TYPE_GROUP_PARAMETER) && parameter_position && first_operand && c == '.' && lexer->lookahead == '.') {
                advance(lexer);
                if (lexer->lookahead != '.') break;
                advance(lexer);
                group->parameter_pattern |= TYPE_PARAMETER_PATTERN_REST_SLOT | TYPE_PARAMETER_PATTERN_COMPLETED_BINDING;
                group->property = false;
                continue;
            }
            if (check_type_operands && frame == TYPE_OPERAND_GROUP_END && parameter_position && first_operand && c == '.' && lexer->lookahead == '.') {
                advance(lexer);
                if (lexer->lookahead != '.') break;
                advance(lexer);
                if (complete_conditionals && !group->default_value) { group->expression_only = true; group->parameter_header = true; group->parameter_pattern |= TYPE_PARAMETER_PATTERN_REST_SLOT; group->property = false; }
                continue;
            }
            if (complete_conditionals && check_type_operands && frame == ']' && parameter_position && first_operand && c == '.' && lexer->lookahead == '.') {
                advance(lexer);
                if (lexer->lookahead != '.') break;
                advance(lexer);
                group->parameter_pattern |= TYPE_PARAMETER_PATTERN_REST_SLOT;
                group->property = false;
                continue;
            }
            if (c == '=' && lexer->lookahead != '>') stack[size - 1].context &= ~TYPE_EXPRESSION_TYPE;
            if (check_expression_operands && end == ')') {
                if (c == '=' || c == '?' || c == ':') stack[size - 1].context &= ~TYPE_GROUP_PARAMETER;
                else if (c == ',') stack[size - 1].context |= TYPE_GROUP_PARAMETER;
            }
            bool expression_postfix = (computed_expression || check_expression_operands) && (c == '+' || c == '-') && lexer->lookahead == c && !expression_operand && !first_operand;
            if (html_comments && (c == '<' || c == '-') && scan_type_html_comment_tail(lexer, c)) break;
            if (complete_conditionals && check_type_operands && query_operand &&
                (c == '(' || c == '[' || c == '{' || c == '<') && unsafe_conditional) *unsafe_conditional = true;
            if (c == end) {
                bool expression_arrow = (context & TYPE_EXPRESSION_GROUP) && ((frame & TYPE_GROUP_ROLE_MASK) == FUNCTION_PARAMETER_GROUP_END || (check_expression_operands && expression_operand && (frame & TYPE_EXPRESSION_EMPTY_GROUP) && end == ')'));
                if ((context & TYPE_EXPRESSION_METHOD_BODY) || (check_expression_operands && expression_operand && !expression_arrow)) break;
                if (check_type_operands && frame == COMPUTED_PROPERTY_GROUP_END && !parameter_position && first_operand) break;
                if (check_type_operands && (frame == TYPE_PARAMETER_GROUP_END || frame == METHOD_TYPE_PARAMETER_GROUP_END)) {
                    if (!scan_default_trivia(lexer, true, false) || lexer->lookahead != '(') break;
                    advance(lexer);
                    stack[size - 1].context = frame == METHOD_TYPE_PARAMETER_GROUP_END ? METHOD_PARAMETER_GROUP_END : FUNCTION_PARAMETER_GROUP_END;
                    group->conditional_branch = false;
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
                unsigned pattern = group->parameter_pattern & TYPE_PARAMETER_PATTERN_MASK;
                bool invalid_parameter = (group->parameter_pattern & (TYPE_PARAMETER_PATTERN_INVALID_SLOT | TYPE_PARAMETER_PATTERN_OBJECT_CANDIDATE)) || pattern == TYPE_PARAMETER_PATTERN_NON_PATTERN || pattern == TYPE_PARAMETER_PATTERN_TYPE_ONLY_NON_PATTERN || pattern == TYPE_PARAMETER_PATTERN_INVALID || pattern == TYPE_PARAMETER_PATTERN_PUNCTUATED_NAME || pattern == TYPE_PARAMETER_PATTERN_MEMBER_NAME ||
                    (frame == OBJECT_PROPERTY_GROUP_END && (context & TYPE_GROUP_PARAMETER) && !(context & TYPE_GROUP_FORMAL_BINDING) && !(group->parameter_pattern & TYPE_PARAMETER_PATTERN_COMPLETED_BINDING));
                bool closing_line_break = false;
                if (complete_conditionals && check_type_operands && invalid_parameter && end == ')' &&
                    scan_default_trivia_with_line_break(lexer, true, false, &closing_line_break) && lexer->lookahead == '=' && unsafe_conditional) *unsafe_conditional = true;
                bool parameter_header = (group->parameter_header || (completed_name && (group->prefix & TYPE_GROUP_UNIQUE_PREFIX))) && !invalid_parameter && end == ')' &&
                    scan_default_trivia_with_line_break(lexer, true, false, &closing_line_break) && lexer->lookahead == '=';
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
                if (complete_conditionals && check_type_operands && arrow_header && invalid_parameter && unsafe_conditional) *unsafe_conditional = true;
                operand_pending = arrow_header && !return_identifier;
                first_operand = operand_pending;
                query_operand = false;
                if (arrow_header) parameter_position = false;
                if (complete_conditionals && group->default_value && frame == METHOD_PARAMETER_GROUP_END && size > 1) {
                    if (!scan_default_trivia(lexer, true, false)) break;
                    if (lexer->lookahead == ':') stack[size - 2].default_type = true;
                }
                if (complete_conditionals && check_type_operands && frame == TYPE_OPERAND_GROUP_END &&
                    !is_query_argument_expression(stack, size) && !arrow_header && !parameter_header && group->expression_only && unsafe_conditional) *unsafe_conditional = true;
                if (complete_conditionals && check_type_operands && !group->default_value && !is_query_argument_expression(stack, size) &&
                    frame == TYPE_OPERAND_GROUP_END && (group->prefix & TYPE_GROUP_UNIQUE_PREFIX) && !(group->prefix & TYPE_GROUP_ASSERTION_SUBJECT) && !arrow_header && !parameter_header && unsafe_conditional) *unsafe_conditional = true;
                if (complete_conditionals && check_type_operands && !group->default_value && group->expression_only &&
                    (frame == ']' || frame == OBJECT_PROPERTY_GROUP_END) && !is_query_argument_expression(stack, size)) {
                    if (size == 1 || invalid_parameter) { if (unsafe_conditional) *unsafe_conditional = true; }
                    else { stack[size - 2].expression_only = true; stack[size - 2].parameter_header = true; }
                }
                closing_line_break = closing_line_break && !arrow_header && !parameter_header && lexer->lookahead != '=';
                if (--size == 0) {
                    if (completion && closing_line_break) *completion |= TYPE_GROUP_TRAILING_LINE_BREAK;
                    if (completion && arrow_header) *completion |= return_identifier ? TYPE_GROUP_RETURN_IDENTIFIER : TYPE_GROUP_RETURN_OPERAND;
                    result = true;
                    break;
                }
                if (closing_line_break && (stack[size - 1].context & TYPE_GROUP_ROLE_MASK) == OBJECT_PROPERTY_GROUP_END) member_line_break = true;
                if ((arrow_header || frame == METHOD_PARAMETER_GROUP_END) && (stack[size - 1].object_query_owner & TYPE_OBJECT_QUERY_PARENTHESIZED)) stack[size - 1].object_query_owner |= TYPE_OBJECT_QUERY_RETURN;
                if (complete_conditionals && check_type_operands) {
                    if (arrow_header) {
                        stack[size - 1].predicate_subject = return_identifier ? TYPE_PREDICATE_SUBJECT_NAME : TYPE_PREDICATE_SUBJECT_NONE;
                        stack[size - 1].return_owner = (stack[size - 1].prefix & TYPE_GROUP_CONSTRUCTOR_PREFIX) ? TYPE_RETURN_CONSTRUCTOR : TYPE_RETURN_FUNCTION;
                    }
                    if (arrow_header && !stack[size - 1].default_value && (stack[size - 1].context & TYPE_GROUP_ROLE_MASK) == TYPE_OPERAND_GROUP_END && !is_query_argument_expression(stack, size)) stack[size - 1].context &= ~TYPE_GROUP_FORMAL_BINDING;
                    if (stack[size - 1].default_parameter && (stack[size - 1].parameter_pattern & TYPE_PARAMETER_PATTERN_REST_SLOT)) {
                        if (arrow_header && !stack[size - 1].default_type) stack[size - 1].parameter_pattern &= ~TYPE_PARAMETER_PATTERN_REST_SLOT;
                        else if (frame == TYPE_OPERAND_GROUP_END && !arrow_header) stack[size - 1].parameter_pattern = (stack[size - 1].parameter_pattern & ~TYPE_PARAMETER_PATTERN_MASK) | TYPE_PARAMETER_PATTERN_NAME;
                    }
                    if (arrow_header && !stack[size - 1].default_value && (stack[size - 1].parameter_pattern & TYPE_PARAMETER_PATTERN_MASK) == TYPE_PARAMETER_PATTERN_NAME) stack[size - 1].parameter_pattern = (stack[size - 1].parameter_pattern & TYPE_PARAMETER_PATTERN_INVALID_SLOT) | TYPE_PARAMETER_PATTERN_NON_PATTERN;
                    if (frame == OBJECT_PROPERTY_GROUP_END && invalid_parameter && (stack[size - 1].parameter_pattern & TYPE_PARAMETER_PATTERN_MASK) == TYPE_PARAMETER_PATTERN_NAME) {
                        stack[size - 1].parameter_pattern |= TYPE_PARAMETER_PATTERN_OBJECT_CANDIDATE;
                        if (!group->binding_type && pattern == TYPE_PARAMETER_PATTERN_NONE && !(group->parameter_pattern & (TYPE_PARAMETER_PATTERN_INVALID_SLOT | TYPE_PARAMETER_PATTERN_OPTIONAL_SLOT))) stack[size - 1].parameter_pattern |= TYPE_PARAMETER_PATTERN_ANNOTATABLE_OBJECT;
                    }
                    if (frame == ']' && (context & TYPE_GROUP_PARAMETER) && invalid_parameter && (stack[size - 1].parameter_pattern & TYPE_PARAMETER_PATTERN_MASK) == TYPE_PARAMETER_PATTERN_NAME) stack[size - 1].parameter_pattern = (stack[size - 1].parameter_pattern & TYPE_PARAMETER_PATTERN_INVALID_SLOT) | TYPE_PARAMETER_PATTERN_NON_PATTERN;
                    if ((stack[size - 1].context & TYPE_GROUP_ROLE_MASK) == ']' && (stack[size - 1].context & TYPE_GROUP_PARAMETER) &&
                        (frame == '>' || (frame == ']' && !(context & TYPE_GROUP_PARAMETER) && pattern == TYPE_PARAMETER_PATTERN_NONE))) stack[size - 1].parameter_pattern = (stack[size - 1].parameter_pattern & TYPE_PARAMETER_PATTERN_INVALID_SLOT) | TYPE_PARAMETER_PATTERN_TYPE_ONLY_NON_PATTERN;
                    if ((stack[size - 1].context & TYPE_GROUP_ROLE_MASK) == ']' && (stack[size - 1].context & TYPE_GROUP_PARAMETER) &&
                        ((frame == ']' && (context & TYPE_GROUP_PARAMETER)) || frame == OBJECT_PROPERTY_GROUP_END)) stack[size - 1].parameter_pattern = (stack[size - 1].parameter_pattern & ~TYPE_PARAMETER_PATTERN_MASK) | (invalid_parameter ? TYPE_PARAMETER_PATTERN_TYPE_ONLY_NON_PATTERN : TYPE_PARAMETER_PATTERN_TYPE_ONLY);
                    if (frame == '>' && (stack[size - 1].context & TYPE_GROUP_END_MASK) == ')' && !stack[size - 1].default_value &&
                        (stack[size - 1].parameter_pattern & TYPE_PARAMETER_PATTERN_MASK) == TYPE_PARAMETER_PATTERN_NAME && !is_query_argument_expression(stack, size)) stack[size - 1].parameter_pattern = (stack[size - 1].parameter_pattern & ~TYPE_PARAMETER_PATTERN_MASK) | TYPE_PARAMETER_PATTERN_TYPE_ONLY_NON_PATTERN;
                    if (!stack[size - 1].default_value && !(stack[size - 1].prefix & TYPE_GROUP_CONSTRUCTOR_PREFIX) && (stack[size - 1].context & TYPE_GROUP_END_MASK) == ')' &&
                        (stack[size - 1].parameter_pattern & TYPE_PARAMETER_PATTERN_MASK) == TYPE_PARAMETER_PATTERN_NAME && !is_query_argument_expression(stack, size) &&
                        ((frame == TYPE_OPERAND_GROUP_END && !arrow_header) || frame == OBJECT_PROPERTY_GROUP_END ||
                         (frame == ']' && ((context & TYPE_GROUP_PARAMETER) || !first_operand)))) stack[size - 1].parameter_header = true;
                    if (!arrow_header && ((context & TYPE_GROUP_FORMAL_BINDING) || (frame == ']' && !(context & TYPE_GROUP_PARAMETER) && !(stack[size - 1].parameter_pattern & TYPE_PARAMETER_PATTERN_INVALID_SLOT)) || (!invalid_parameter && pattern != TYPE_PARAMETER_PATTERN_TYPE_ONLY && pattern != TYPE_PARAMETER_PATTERN_TYPE_ONLY_NON_PATTERN)) && (stack[size - 1].context & TYPE_GROUP_ROLE_MASK) == OBJECT_PROPERTY_GROUP_END && stack[size - 1].binding_type && !stack[size - 1].default_value) stack[size - 1].parameter_pattern |= TYPE_PARAMETER_PATTERN_COMPLETED_BINDING;
                    if (((frame == ']' && (context & TYPE_GROUP_PARAMETER) && !invalid_parameter) || (frame == OBJECT_PROPERTY_GROUP_END && !invalid_parameter && (group->parameter_pattern & TYPE_PARAMETER_PATTERN_COMPLETED_BINDING))) && !stack[size - 1].default_value && (stack[size - 1].context & TYPE_GROUP_END_MASK) == ')' && !is_query_argument_expression(stack, size)) stack[size - 1].parameter_pattern |= TYPE_PARAMETER_PATTERN_COMPLETED_BINDING;
                    TypeGroupPrefix prefix = stack[size - 1].prefix;
                    bool parenthesized_operand = frame == TYPE_OPERAND_GROUP_END && !arrow_header && !(context & TYPE_QUERY_ARGUMENT_GROUP);
                    if (unsafe_conditional && (((prefix & TYPE_GROUP_PRIMARY_PREFIX) && arrow_header) ||
                        ((prefix & TYPE_GROUP_CONSTRUCTOR_PREFIX) && !arrow_header && !parenthesized_operand) ||
                        ((prefix & TYPE_GROUP_ABSTRACT_PREFIX) && end == ')'))) *unsafe_conditional = true;
                    if (parenthesized_operand && prefix != TYPE_GROUP_NO_PREFIX) stack[size - 1].nonreference_type = true;
                    if (!parenthesized_operand) stack[size - 1].prefix &= TYPE_GROUP_IMPORT_QUERY_PREFIX;
                    else stack[size - 1].prefix |= TYPE_GROUP_PARENTHESIZED_HEADER;
                    if (parenthesized_operand && (group->prefix & (TYPE_GROUP_IMPORT_QUERY_PREFIX | TYPE_GROUP_MEMBER_QUERY_PREFIX)) == (TYPE_GROUP_IMPORT_QUERY_PREFIX | TYPE_GROUP_MEMBER_QUERY_PREFIX)) stack[size - 1].prefix |= TYPE_GROUP_IMPORT_QUERY_PREFIX | TYPE_GROUP_MEMBER_QUERY_PREFIX;
                }
                if (complete_conditionals && check_type_operands && frame == ')' && !(context & TYPE_QUERY_ARGUMENT_GROUP) && !is_query_argument_expression(stack, size) && !arrow_header && unsafe_conditional) *unsafe_conditional = true;
                if (complete_conditionals && check_type_operands && !group->default_value && !arrow_header && !(context & TYPE_QUERY_ARGUMENT_GROUP) &&
                    (frame == TYPE_OPERAND_GROUP_END || frame == OBJECT_PROPERTY_GROUP_END || frame == '>' || frame == ']')) {
                    stack[size - 1].nonreference_type = true;
                }
                if (complete_conditionals && check_type_operands && !group->default_value && (context & TYPE_QUERY_ARGUMENT_GROUP)) {
                    stack[size - 1].prefix |= TYPE_GROUP_MEMBER_QUERY_PREFIX;
                    stack[size - 1].nonreference_type = true;
                }
                if (expression_arrow) stack[size - 1].context |= TYPE_EXPRESSION_OPERAND | TYPE_EXPRESSION_BODY;
                if ((context & TYPE_EXPRESSION_GROUP) && (frame & TYPE_GROUP_ROLE_MASK) == METHOD_PARAMETER_GROUP_END) stack[size - 1].context |= TYPE_EXPRESSION_OPERAND | TYPE_EXPRESSION_METHOD_BODY;
                continue;
            }
            if (c == '\'' || c == '"' || c == '`') {
                if (group->return_owner != TYPE_RETURN_FUNCTION && (group->prefix & TYPE_GROUP_PREDICATE_PREFIX) && previous_predicate_subject == TYPE_PREDICATE_SUBJECT_NONE && unsafe_conditional) *unsafe_conditional = true;
                if (complete_conditionals && check_type_operands && frame == TYPE_OPERAND_GROUP_END && !group->default_value && !computed_expression && !group->property && !query_operand && !first_operand && !operand_pending && previous_predicate_subject != TYPE_PREDICATE_SUBJECT_NONE && !(group->prefix & (TYPE_GROUP_ASSERTS_PREFIX | TYPE_GROUP_PREDICATE_PREFIX))) group->expression_only = true;
                push = c | (check_type_operands && frame == OBJECT_PROPERTY_GROUP_END && parameter_position ? PROPERTY_NAME_GROUP : 0);
                if (c == '`' && frame == COMPUTED_PROPERTY_GROUP_END && parameter_position) push |= TYPE_EXPRESSION_GROUP;
            }
            else if (c == '=') {
                if (lexer->lookahead == '>') {
                    group->return_owner = constructor_header ? TYPE_RETURN_CONSTRUCTOR : TYPE_RETURN_FUNCTION;
                    if (group->object_query_owner & TYPE_OBJECT_QUERY_PARENTHESIZED) group->object_query_owner |= TYPE_OBJECT_QUERY_RETURN;
                    group->predicate_subject = TYPE_PREDICATE_SUBJECT_NONE;
                    if (complete_conditionals && check_type_operands && completed_parenthesized_operand && !group->default_value && previous_parameter_pattern == TYPE_PARAMETER_PATTERN_NAME) group->parameter_pattern = (group->parameter_pattern & TYPE_PARAMETER_PATTERN_INVALID_SLOT) | TYPE_PARAMETER_PATTERN_NON_PATTERN;
                    if (complete_conditionals && check_type_operands && frame == TYPE_OPERAND_GROUP_END &&
                        !group->default_value && !completed_parenthesized_operand) group->expression_only = true;
                    advance(lexer);
                    if (context & TYPE_EXPRESSION_TYPE) {
                        stack[size - 1].context &= ~TYPE_EXPRESSION_TYPE;
                        stack[size - 1].context |= TYPE_EXPRESSION_OPERAND | TYPE_EXPRESSION_BODY;
                    }
                    if (check_expression_operands || computed_expression) stack[size - 1].context |= TYPE_EXPRESSION_BODY;
                }
            }
            else if (c == '<') push = check_type_operands && frame == OBJECT_PROPERTY_GROUP_END && parameter_position ? METHOD_TYPE_PARAMETER_GROUP_END : check_type_operands && first_operand ? TYPE_PARAMETER_GROUP_END : '>';
            else if (c == '(') {
                push = check_type_operands && frame == OBJECT_PROPERTY_GROUP_END && parameter_position ? METHOD_PARAMETER_GROUP_END : check_type_operands && !binding_frame && (operand_pending || first_operand) ? TYPE_OPERAND_GROUP_END : ')';
                if (check_type_operands && (group->prefix & TYPE_GROUP_CONSTRUCTOR_PREFIX)) push |= TYPE_GROUP_FORMAL_BINDING;
                if (check_type_operands && group->query_call_operand && !group->default_value && push == ')') push |= TYPE_QUERY_ARGUMENT_GROUP;
            }
            else if (c == '[') {
                push = check_type_operands && frame == OBJECT_PROPERTY_GROUP_END && parameter_position ? COMPUTED_PROPERTY_GROUP_END : ']';
                if (push == ']' && parameter_pattern_position && first_operand) push |= TYPE_GROUP_PARAMETER;
            }
            else if (c == '{') {
                if (complete_conditionals && check_type_operands && frame == TYPE_OPERAND_GROUP_END &&
                    !group->default_value && !first_operand && !operand_pending) {
                    group->expression_only = true;
                }
                push = check_type_operands ? OBJECT_PROPERTY_GROUP_END : '}';
                if (check_type_operands && parameter_pattern_position && first_operand) push |= TYPE_GROUP_PARAMETER;
                if (check_type_operands && !computed_expression && lexer->lookahead == '|') {
                    advance(lexer);
                    exact_object = true;
                }
            }
            else if (c == ')' || c == ']' || c == '}' || (c == ';' && end == '>')) break;
            if (computed_expression && !is_whitespace(c) && !(c == ':' && !first_operand)) stack[size - 1].context |= TYPE_EXPRESSION_GROUP;
            if (push && computed_expression) push |= TYPE_EXPRESSION_GROUP;
            if ((computed_expression || check_expression_operands) && !is_whitespace(c)) {
                bool member_name = (frame & TYPE_GROUP_ROLE_MASK) == OBJECT_PROPERTY_GROUP_END && (frame & TYPE_EXPRESSION_PROPERTY);
                bool method_body = c == '{' && (frame & TYPE_EXPRESSION_METHOD_BODY) && !first_operand;
                if (c == '{' && !(frame & TYPE_EXPRESSION_BODY) && !method_body) push = OBJECT_PROPERTY_GROUP_END | TYPE_EXPRESSION_GROUP | TYPE_EXPRESSION_PROPERTY;
                if (method_body) stack[size - 1].context &= ~TYPE_EXPRESSION_METHOD_BODY;
                if (c == '(' && (member_name || (frame & TYPE_EXPRESSION_FUNCTION))) {
                    push = METHOD_PARAMETER_GROUP_END | TYPE_EXPRESSION_GROUP | TYPE_GROUP_PARAMETER;
                    stack[size - 1].context &= ~TYPE_EXPRESSION_FUNCTION;
                }
                if (c == ',' && (frame & TYPE_GROUP_ROLE_MASK) == OBJECT_PROPERTY_GROUP_END) stack[size - 1].context |= TYPE_EXPRESSION_PROPERTY;
                if (c == '(') push |= TYPE_GROUP_PARAMETER;
                if (push) stack[size - 1].context &= ~TYPE_EXPRESSION_BODY;
                stack[size - 1].context &= ~TYPE_EXPRESSION_EMPTY_GROUP;
                if (expression_postfix && lexer->lookahead == c) advance(lexer);
                if (!expression_postfix && (c == '+' || c == '-' || (c == '*' && !member_name && !(frame & TYPE_EXPRESSION_FUNCTION)) || c == '%' || c == '^' || c == '|' || c == '&' || c == '=' || c == '>' || c == '?' || c == '~' || (c == '!' && lexer->lookahead == '=') || (c == ':' && (end != '}' || (frame & TYPE_GROUP_ROLE_MASK) == TYPE_SUBSTITUTION_GROUP_END || (frame & TYPE_GROUP_ROLE_MASK) == OBJECT_PROPERTY_GROUP_END)) || (c == ',' && end == ']' && (frame & TYPE_GROUP_ROLE_MASK) == COMPUTED_PROPERTY_GROUP_END))) {
                    stack[size - 1].context |= TYPE_EXPRESSION_OPERAND;
                    stack[size - 1].context &= ~TYPE_EXPRESSION_PROPERTY;
                } else if (c == '.') {
                    stack[size - 1].context |= TYPE_EXPRESSION_PROPERTY;
                    if (is_ascii_digit(lexer->lookahead)) stack[size - 1].context &= ~TYPE_EXPRESSION_OPERAND;
                } else if (push) {
                    stack[size - 1].context &= ~TYPE_EXPRESSION_OPERAND;
                    if (!member_name || c != '[') stack[size - 1].context &= ~TYPE_EXPRESSION_PROPERTY;
                    if (c == '(' && (push & TYPE_GROUP_ROLE_MASK) != METHOD_PARAMETER_GROUP_END && ((expression_operand && !(frame & TYPE_EXPRESSION_PROPERTY)) || (computed_expression && first_operand))) push |= TYPE_EXPRESSION_OPERAND | TYPE_EXPRESSION_EMPTY_GROUP;
                }
            }
            if (!is_whitespace(c)) {
                if (close == UNTYPED_PARAMETER_GROUP_END && size == 1) {
                    if (c == ',') {
                        slot_named = false;
                        slot_annotation = false;
                    } else if (c == ':' || c == '=') slot_annotation = true;
                }
                bool member_separator = c == ';' && frame == OBJECT_PROPERTY_GROUP_END;
                first_operand = c == '(' || c == '[' || c == '{' || c == '<' || c == ',' || c == '|' || c == '&' || c == '?' || c == ':' || c == '=' || member_separator;
                parameter_position = c == '(' || c == '[' || c == '{' || c == ',' || member_separator || push == TYPE_PARAMETER_GROUP_END || push == METHOD_TYPE_PARAMETER_GROUP_END || (c == '?' && (frame == OBJECT_PROPERTY_GROUP_END || frame == TYPE_OPERAND_GROUP_END) && parameter_position);
                if (optional_chain_dot) {
                    first_operand = false;
                    parameter_position = false;
                }
                operand_pending = expression_annotation;
                query_operand = false;
            }
        }
        if (push) {
            if (formal_binding_owner) push |= TYPE_GROUP_FORMAL_BINDING;
            if (parameter_pattern_position) {
                unsigned pattern = (group->parameter_pattern & TYPE_PARAMETER_PATTERN_MASK) == TYPE_PARAMETER_PATTERN_INVALID ? TYPE_PARAMETER_PATTERN_INVALID : c == '\'' || c == '"' || c == '`' ? TYPE_PARAMETER_PATTERN_NON_PATTERN : TYPE_PARAMETER_PATTERN_NAME;
                group->parameter_pattern = (group->parameter_pattern & (TYPE_PARAMETER_PATTERN_INVALID_SLOT | TYPE_PARAMETER_PATTERN_OBJECT_CANDIDATE | TYPE_PARAMETER_PATTERN_ANNOTATABLE_OBJECT | TYPE_PARAMETER_PATTERN_REST_SLOT)) | pattern;
            }
            group->operand_required = false;
            if (size == capacity) {
                capacity *= 2;
                TypeGroupFrame *grown = ts_realloc(stack, capacity * sizeof(TypeGroupFrame));
                if (!grown) break;
                stack = grown;
            }
            if ((push & TYPE_GROUP_ROLE_MASK) == TYPE_OPERAND_GROUP_END && !(push & TYPE_EXPRESSION_GROUP)) push |= TYPE_GROUP_PARAMETER;
            bool default_value = stack[size - 1].default_value;
            bool default_type = stack[size - 1].default_type || (default_value && c == '<');
            bool default_declaration_header = default_value && c == '<' && stack[size - 1].default_declaration_header;
            bool query_argument_ancestor = is_query_argument_expression(stack, size);
            unsigned object_query_owner = ((push & TYPE_GROUP_ROLE_MASK) == OBJECT_PROPERTY_GROUP_END || ((push & TYPE_GROUP_ROLE_MASK) == ']' && (push & TYPE_GROUP_PARAMETER))) &&
                !(push & (TYPE_GROUP_FORMAL_BINDING | TYPE_EXPRESSION_GROUP)) && !default_value && !query_argument_ancestor &&
                ((frame == TYPE_OPERAND_GROUP_END && (stack[size - 1].context & TYPE_GROUP_PARAMETER) && stack[size - 1].return_owner == TYPE_RETURN_NONE) ||
                 ((frame == ']' || (frame == OBJECT_PROPERTY_GROUP_END && stack[size - 1].binding_type)) && stack[size - 1].object_query_owner == TYPE_OBJECT_QUERY_PARENTHESIZED)) ? TYPE_OBJECT_QUERY_PARENTHESIZED : 0;
            stack[size++] = (TypeGroupFrame){.context = push | (frame & TYPE_EXPRESSION_GROUP), .default_value = default_value, .exact_object = exact_object, .default_type = default_type, .default_declaration_header = default_declaration_header, .query_argument_ancestor = query_argument_ancestor, .object_query_owner = object_query_owner};
        }
    }
    ts_free(stack);
    return result;
}

static bool scan_annotated_type_colons(TSLexer *lexer, bool allow_expression, bool first, bool untyped_return, bool enclosing_conditional, bool *requires_conditional_parameter) {
    unsigned conditional_depth = 0;
    bool saw_extends = false, conditional_question_pending = false, infer_name = false, infer_constraint = false;
    bool query_operand = false, type_query_return = false, member_property = false, predicate_name = false, return_operand = first, abstract_constructor = false, predicate_start = first;
    bool nonreference_type = false, unsafe_conditional = false, query_call_operand = false, assertion_predicate = false;
    TypeReturnOwner return_owner = untyped_return ? TYPE_RETURN_FUNCTION : TYPE_RETURN_NONE;
    TypePredicateSubject predicate_subject = untyped_return && !first ? TYPE_PREDICATE_SUBJECT_NAME : TYPE_PREDICATE_SUBJECT_NONE;
    TypeGroupPrefix group_prefix = TYPE_GROUP_NO_PREFIX;
    bool trailing_group_line_break = false;
    while (!lexer->eof(lexer)) {
        bool line_break = false;
        if (!scan_default_trivia_with_line_break(lexer, true, false, &line_break)) return !untyped_return || (!return_operand && !member_property && conditional_depth == 0 && !conditional_question_pending);
        line_break |= trailing_group_line_break;
        trailing_group_line_break = false;
        int32_t c = lexer->lookahead;
        bool pending_contextual_predicate = untyped_return && (group_prefix & TYPE_GROUP_PREDICATE_PREFIX);
        bool constructor_header = nonreference_type && (group_prefix & TYPE_GROUP_CONSTRUCTOR_PREFIX) && c == '=';
        if (untyped_return && ((query_operand && (!is_identifier_part(c) || is_ascii_digit(c))) ||
            (infer_name && starts_non_identifier_type_operand(c)))) unsafe_conditional = true;
        if (untyped_return && assertion_predicate && !is_identifier_part(c)) unsafe_conditional = true;
        if (untyped_return && (group_prefix & TYPE_GROUP_ASSERTION_SUBJECT) && (c == '<' || c == '(' || c == '[' || c == '.' || c == '{')) unsafe_conditional = true;
        if (nonreference_type) {
            if (untyped_return && (((group_prefix & TYPE_GROUP_PRIMARY_PREFIX) && c == '=') ||
                ((group_prefix & TYPE_GROUP_CONSTRUCTOR_PREFIX) && c != '='))) unsafe_conditional = true;
            bool query_call = group_prefix & TYPE_GROUP_MEMBER_QUERY_PREFIX;
            group_prefix = TYPE_GROUP_NO_PREFIX;
            if (c == '<' || c == '(' || (c == '.' && !query_call)) unsafe_conditional = true;
            if (c != '[') nonreference_type = false;
        }
        if (lexer->eof(lexer) || c == ')' || c == ']' || c == '}' || c == ',' || c == ';' || c == '>') return !untyped_return || (!return_operand && !member_property && conditional_depth == 0 && !conditional_question_pending);
        if (is_identifier_part(c)) {
            char word[16] = {0};
            bool ascii_word = false;
            if (untyped_return && is_ascii_digit(c)) {
                if (!scan_type_numeric_operand(lexer)) return false;
                if (!query_operand && is_identifier_part(lexer->lookahead)) unsafe_conditional = true;
            } else ascii_word = scan_identifier(lexer, word, sizeof(word), false);
            if (untyped_return && line_break && conditional_depth == 0 && !conditional_question_pending && !return_operand && !member_property &&
                !(ascii_word && (strcmp(word, "is") == 0 || strcmp(word, "extends") == 0 ||
                                  (abstract_constructor && strcmp(word, "new") == 0)))) return true;
            if (pending_contextual_predicate && !(ascii_word && strcmp(word, "extends") == 0)) {
                if (return_owner == TYPE_RETURN_CONSTRUCTOR) unsafe_conditional = true;
                first = true;
                return_operand = true;
                predicate_subject = TYPE_PREDICATE_SUBJECT_NONE;
            }
            if (untyped_return && !member_property && ascii_word && (strcmp(word, "new") == 0 || strcmp(word, "import") == 0)) {
                if (predicate_name || !scan_default_trivia(lexer, true, false)) return false;
                if (lexer->lookahead != '(' && !(strcmp(word, "new") == 0 && lexer->lookahead == '<')) return false;
            }
            if (untyped_return && predicate_name && ascii_word && is_type_probe_word(word, TS_NON_ASSERTION_IDENTIFIER_KEYWORDS, sizeof(TS_NON_ASSERTION_IDENTIFIER_KEYWORDS) / sizeof(TS_NON_ASSERTION_IDENTIFIER_KEYWORDS[0]))) unsafe_conditional = true;
            if (untyped_return && assertion_predicate && !(ascii_word && strcmp(word, "is") == 0)) unsafe_conditional = true;
            assertion_predicate = untyped_return && predicate_name && ascii_word && is_type_probe_word(word, TS_ASSERTION_PREDICATE_SUBJECT_KEYWORDS, sizeof(TS_ASSERTION_PREDICATE_SUBJECT_KEYWORDS) / sizeof(TS_ASSERTION_PREDICATE_SUBJECT_KEYWORDS[0]));
            TypePredicateSubject previous_subject = predicate_subject;
            TypeGroupPrefix previous_prefix = group_prefix;
            bool predicate_word = ascii_word && strcmp(word, "is") == 0 && !member_property && !query_operand && previous_subject != TYPE_PREDICATE_SUBJECT_NONE;
            bool unique_completion = ascii_word && strcmp(word, "symbol") == 0 && (previous_prefix & TYPE_GROUP_UNIQUE_PREFIX) && previous_subject == TYPE_PREDICATE_SUBJECT_NAME && !member_property && !query_operand;
            bool assertion_unique_completion = unique_completion && (previous_prefix & TYPE_GROUP_ASSERTION_SUBJECT);
            bool assertion_subject = untyped_return && predicate_name;
            bool assertion_is = assertion_subject && ascii_word && strcmp(word, "is") == 0;
            if (untyped_return) {
                if (predicate_word && previous_subject != TYPE_PREDICATE_SUBJECT_NAME) unsafe_conditional = true;
                if ((group_prefix & TYPE_GROUP_ASSERTION_SUBJECT) && !unique_completion && !(ascii_word && strcmp(word, "is") == 0)) unsafe_conditional = true;
                predicate_subject = predicate_word ? TYPE_PREDICATE_SUBJECT_NONE :
                    is_type_predicate_name_word(c, word, ascii_word) && !member_property && !query_operand &&
                    (previous_subject == TYPE_PREDICATE_SUBJECT_NONE || assertion_subject || unique_completion) ? TYPE_PREDICATE_SUBJECT_NAME : TYPE_PREDICATE_SUBJECT_COMPOSED;
            }
            if (untyped_return) group_prefix = update_type_group_prefix(group_prefix, ascii_word ? word : "", first && !query_operand && !member_property && !predicate_name, &unsafe_conditional);
            if (assertion_subject && !assertion_is) group_prefix = TYPE_GROUP_ASSERTION_SUBJECT | (ascii_word && strcmp(word, "unique") == 0 ? TYPE_GROUP_UNIQUE_PREFIX : 0);
            if (assertion_unique_completion) { group_prefix = TYPE_GROUP_ASSERTION_SUBJECT; assertion_predicate = true; }
            if (untyped_return && first && !query_operand && !member_property) {
                query_call_operand = ascii_word && (strcmp(word, "typeof") == 0 || strcmp(word, "import") == 0);
            }
            nonreference_type = untyped_return && !query_operand && !assertion_subject && !assertion_unique_completion &&
                (is_ascii_digit(c) || (!member_property && (infer_name || (ascii_word && is_nonreference_type_word(word)))));
            abstract_constructor = return_operand && !member_property && ascii_word && strcmp(word, "abstract") == 0;
            bool contextual_predicate = return_operand && previous_subject == TYPE_PREDICATE_SUBJECT_NAME &&
                (infer_name || (previous_prefix & (TYPE_GROUP_PRIMARY_PREFIX | TYPE_GROUP_READONLY_PREFIX))) &&
                !member_property && ascii_word && strcmp(word, "is") == 0;
            bool predicate_operator = (!return_operand || assertion_is) && !member_property && ascii_word && strcmp(word, "is") == 0;
            if (untyped_return && return_owner == TYPE_RETURN_CONSTRUCTOR && (predicate_operator || assertion_subject)) unsafe_conditional = true;
            if (contextual_predicate) {
                group_prefix = TYPE_GROUP_PREDICATE_PREFIX;
                predicate_subject = TYPE_PREDICATE_SUBJECT_NAME;
            }
            bool extends_operand = ascii_word && strcmp(word, "extends") == 0 &&
                (!untyped_return || (!return_operand && !member_property));
            bool asserts_prefix = !member_property && (predicate_start || !return_operand) && ascii_word && strcmp(word, "asserts") == 0;
            bool type_prefix = first || !return_operand;
            bool infer_extends = infer_constraint;
            infer_constraint = infer_name;
            infer_name = untyped_return && !member_property && type_prefix && ascii_word && strcmp(word, "infer") == 0;
            return_operand = !member_property && ascii_word &&
                (asserts_prefix || predicate_operator || extends_operand || (type_prefix && (strcmp(word, "infer") == 0 ||
                 strcmp(word, "typeof") == 0 || strcmp(word, "keyof") == 0 || strcmp(word, "readonly") == 0 ||
                 strcmp(word, "new") == 0 || strcmp(word, "import") == 0)));
            if (assertion_is) return_operand = false;
            predicate_name = untyped_return && asserts_prefix;
            predicate_start = false;
            member_property = false;
            if (query_operand) {
                if (untyped_return && ascii_word && strcmp(word, "this") == 0) {
                    nonreference_type = true;
                    group_prefix = TYPE_GROUP_MEMBER_QUERY_PREFIX;
                }
                if (ascii_word && strcmp(word, "typeof") == 0) return false;
                query_operand = false;
            } else if (!allow_expression && first && ascii_word) {
                if (strcmp(word, "unique") == 0) {
                    if (!scan_default_trivia(lexer, true, false) || !scan_identifier(lexer, word, sizeof(word), false) || strcmp(word, "symbol") != 0) return false;
                    nonreference_type = untyped_return;
                } else if (strcmp(word, "typeof") == 0 || strcmp(word, "keyof") == 0 || strcmp(word, "readonly") == 0 || strcmp(word, "infer") == 0) {
                    type_query_return |= strcmp(word, "typeof") == 0;
                    if (!scan_default_trivia(lexer, true, false) || lexer->eof(lexer)) return false;
                    switch (lexer->lookahead) {
                        case '\\':
                            if (!scan_type_identifier_operand(lexer)) return false;
                            query_operand = false;
                            first = false;
                            return_operand = false;
                            group_prefix = TYPE_GROUP_NO_PREFIX;
                            nonreference_type = infer_name;
                            infer_constraint = infer_name;
                            infer_name = false;
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
            if (extends_operand) {
                saw_extends = true;
                if (untyped_return && !infer_extends) conditional_question_pending = true;
            }
            first = !allow_expression && ((untyped_return && predicate_operator) || extends_operand || (first && ascii_word && (strcmp(word, "new") == 0 || strcmp(word, "abstract") == 0)));
            continue;
        }
        if (pending_contextual_predicate && (c == '\\' || c == '\'' || c == '"' || c == '`' || c == '+' || c == '-' || c == '{')) {
            if (return_owner == TYPE_RETURN_CONSTRUCTOR) unsafe_conditional = true;
            first = true;
            return_operand = true;
            predicate_subject = TYPE_PREDICATE_SUBJECT_NONE;
        }
        bool generic_parameters = !allow_expression && first && c == '<';
        bool parenthesized_type = c == '(' && first;
        bool pending_operand = return_operand || member_property;
        if (untyped_return && (c == ':' || (c == '?' && saw_extends)) && pending_operand) return false;
        if (untyped_return && is_type_probe_punctuation(c)) {
            if (line_break && !pending_operand && !conditional_depth && !conditional_question_pending &&
                (c == '+' || c == '-' || c == '!' || c == '~' || c == '#' || c == '@')) return true;
            if ((c != '+' && c != '-') || !return_operand) return false;
            advance(lexer);
            if (!scan_default_trivia(lexer, true, false)) return false;
            if (lexer->lookahead == '.') advance(lexer);
            if (!is_ascii_digit(lexer->lookahead)) return false;
            continue;
        }
        if (untyped_return && !is_whitespace(c)) predicate_subject = (c == ',' || c == ':' || c == ';') ? TYPE_PREDICATE_SUBJECT_NONE : TYPE_PREDICATE_SUBJECT_COMPOSED;
        advance(lexer);
        if (untyped_return && c == '?') {
            if (enclosing_conditional && !saw_extends && (type_query_return || unsafe_conditional) && lexer->lookahead == '.') return false;
            if (enclosing_conditional && !saw_extends && lexer->lookahead == '.' && requires_conditional_parameter) *requires_conditional_parameter = true;
            if (!scan_type_question_tail(lexer, saw_extends || enclosing_conditional)) return false;
            if (!saw_extends) return !pending_operand;
        }
        if ((c == '<' || c == '-') && scan_type_html_comment_tail(lexer, c)) return false;
        member_property = c == '.';
        predicate_name = false;
        infer_name = false;
        infer_constraint = false;
        first = false;
        return_operand = false;
        abstract_constructor = false;
        predicate_start = false;
        if (c == ':') {
            if (conditional_depth == 0) return false;
            conditional_depth--;
            first = !allow_expression;
            return_operand = first;
        } else if (c == '?' && (saw_extends || allow_expression)) {
            conditional_question_pending = false;
            if (allow_expression && lexer->lookahead == '?') advance(lexer);
            else if (allow_expression && lexer->lookahead == '.') {
                advance(lexer);
                if (is_ascii_digit(lexer->lookahead)) conditional_depth++;
            } else conditional_depth++;
            first = !allow_expression;
            return_operand = first;
        } else if (!allow_expression && (c == '|' || c == '&')) {
            type_query_return = false;
            first = true;
            return_operand = true;
        } else if (c == '=') {
            if (lexer->lookahead != '>') return !untyped_return || (!pending_operand && conditional_depth == 0 && !conditional_question_pending);
            advance(lexer);
            return_owner = constructor_header ? TYPE_RETURN_CONSTRUCTOR : TYPE_RETURN_FUNCTION;
            predicate_subject = TYPE_PREDICATE_SUBJECT_NONE;
            first = !allow_expression;
            return_operand = first;
            predicate_start = first;
        } else if (c == '<' || c == '(' || c == '[' || c == '{') {
            int32_t close = c == '<' ? '>' : c == '(' ? ')' : c == '[' ? ']' : '}';
            if (untyped_return && c == '(' && (group_prefix & TYPE_GROUP_CONSTRUCTOR_PREFIX)) close |= TYPE_GROUP_FORMAL_BINDING;
            if (untyped_return && c == '(' && !parenthesized_type && query_call_operand) close |= TYPE_QUERY_ARGUMENT_GROUP;
            unsigned completion = 0;
            if (!scan_type_group(lexer, generic_parameters ? TYPE_PARAMETER_GROUP_END : close, !allow_expression, true, &completion, untyped_return, &unsafe_conditional)) return allow_expression;
            trailing_group_line_break = completion & TYPE_GROUP_TRAILING_LINE_BREAK;
            bool pending_return = completion & TYPE_GROUP_RETURN_OPERAND;
            if (completion & (TYPE_GROUP_RETURN_OPERAND | TYPE_GROUP_RETURN_IDENTIFIER)) return_owner = (group_prefix & TYPE_GROUP_CONSTRUCTOR_PREFIX) ? TYPE_RETURN_CONSTRUCTOR : TYPE_RETURN_FUNCTION;
            predicate_subject = completion & TYPE_GROUP_RETURN_IDENTIFIER ? TYPE_PREDICATE_SUBJECT_NAME : pending_return ? TYPE_PREDICATE_SUBJECT_NONE : TYPE_PREDICATE_SUBJECT_COMPOSED;
            if (untyped_return && query_operand) unsafe_conditional = true;
            if (untyped_return && (((group_prefix & TYPE_GROUP_PRIMARY_PREFIX) && pending_return) ||
                ((group_prefix & TYPE_GROUP_CONSTRUCTOR_PREFIX) && !pending_return && !parenthesized_type) ||
                ((group_prefix & TYPE_GROUP_ABSTRACT_PREFIX) && (c == '(' || generic_parameters)))) unsafe_conditional = true;
            if (!parenthesized_type || pending_return) group_prefix = TYPE_GROUP_NO_PREFIX;
            if (!pending_return && !generic_parameters && !(close & TYPE_QUERY_ARGUMENT_GROUP) &&
                (parenthesized_type || c == '{' || c == '<' || c == '[')) nonreference_type = true;
            if (untyped_return && (close & TYPE_QUERY_ARGUMENT_GROUP)) {
                group_prefix = TYPE_GROUP_MEMBER_QUERY_PREFIX;
                nonreference_type = true;
            }
            if (c == '(' && !parenthesized_type && !pending_return && !pending_operand && !type_query_return) unsafe_conditional = true;
            if (c == '<' || c == '[') type_query_return = false;
            first = generic_parameters || (!allow_expression && c == '(');
            return_operand = generic_parameters || pending_return;
            predicate_start = pending_return;
        } else if (c == '\'' || c == '"' || c == '`') {
            while (!lexer->eof(lexer) && lexer->lookahead != c) {
                int32_t part = lexer->lookahead;
                advance(lexer);
                if (part == '\\' && !lexer->eof(lexer)) advance(lexer);
                else if (c == '`' && part == '$' && lexer->lookahead == '{') {
                    advance(lexer);
                    if (!scan_type_group(lexer, allow_expression ? '}' : TYPE_SUBSTITUTION_GROUP_END, !allow_expression, true, NULL, untyped_return, &unsafe_conditional)) return allow_expression;
                }
            }
            if (lexer->eof(lexer)) {
                if (untyped_return) return false;
            } else advance(lexer);
            if (untyped_return && (group_prefix & (TYPE_GROUP_CONSTRUCTOR_PREFIX | TYPE_GROUP_ABSTRACT_PREFIX))) unsafe_conditional = true;
            group_prefix = TYPE_GROUP_NO_PREFIX;
            nonreference_type = untyped_return;
        }
    }
    return !untyped_return || (!return_operand && !member_property && conditional_depth == 0 && !conditional_question_pending);
}

static TypeGroupPrefix update_type_group_prefix(TypeGroupPrefix prefix, const char *word, bool first, bool *unsafe_conditional) {
    if (!first) return TYPE_GROUP_NO_PREFIX;
    bool constructor = strcmp(word, "new") == 0;
    if (unsafe_conditional && ((prefix & TYPE_GROUP_CONSTRUCTOR_PREFIX) || ((prefix & TYPE_GROUP_PRIMARY_PREFIX) && constructor))) *unsafe_conditional = true;
    static const struct { const char *word; TypeGroupPrefix prefix; } prefixes[] = {
        {"asserts", TYPE_GROUP_ASSERTS_PREFIX},
        {"unique", TYPE_GROUP_UNIQUE_PREFIX},
        {"keyof", TYPE_GROUP_PRIMARY_PREFIX},
    };
    for (unsigned i = 0; i < sizeof(prefixes) / sizeof(prefixes[0]); i++) {
        if (strcmp(word, prefixes[i].word) == 0) return prefixes[i].prefix;
    }
    if (constructor) return TYPE_GROUP_CONSTRUCTOR_PREFIX | (prefix & TYPE_GROUP_PRIMARY_PREFIX);
    bool type_only = prefix & (TYPE_GROUP_PRIMARY_PREFIX | TYPE_GROUP_TYPE_PREFIX);
    bool repeated_readonly = prefix & (TYPE_GROUP_PRIMARY_PREFIX | TYPE_GROUP_TYPE_PREFIX | TYPE_GROUP_READONLY_PREFIX);
    if (strcmp(word, "readonly") == 0) return repeated_readonly ? TYPE_GROUP_TYPE_PREFIX : TYPE_GROUP_READONLY_PREFIX;
    if (strcmp(word, "typeof") == 0 && type_only) return TYPE_GROUP_TYPE_PREFIX;
    if (strcmp(word, "abstract") == 0) return TYPE_GROUP_ABSTRACT_PREFIX | (prefix & TYPE_GROUP_PRIMARY_PREFIX);
    return TYPE_GROUP_NO_PREFIX;
}

static bool is_query_argument_expression(const TypeGroupFrame *stack, unsigned size) {
    if (!size) return false;
    const TypeGroupFrame *group = &stack[size - 1];
    int32_t context = group->context;
    if (context & TYPE_QUERY_ARGUMENT_GROUP) return true;
    int32_t role = context & TYPE_GROUP_ROLE_MASK;
    if ((context & TYPE_EXPRESSION_TYPE) || role == '>' || role == TYPE_PARAMETER_GROUP_END || role == METHOD_TYPE_PARAMETER_GROUP_END ||
        ((role == FUNCTION_PARAMETER_GROUP_END || role == METHOD_PARAMETER_GROUP_END) && !group->default_value)) return false;
    return group->query_argument_ancestor;
}

static bool is_type_predicate_name_word(int32_t first, const char *word, bool ascii_word) {
    return !is_ascii_digit(first) && (!ascii_word || !is_type_probe_word(word, TS_NON_ASSERTION_IDENTIFIER_KEYWORDS, sizeof(TS_NON_ASSERTION_IDENTIFIER_KEYWORDS) / sizeof(TS_NON_ASSERTION_IDENTIFIER_KEYWORDS[0])));
}

static bool is_type_probe_word(const char *word, const char *const *words, unsigned count) {
    for (unsigned i = 0; i < count; i++) {
        if (strcmp(word, words[i]) == 0) return true;
    }
    return false;
}

static bool is_nonreference_type_word(const char *word) {
    return strcmp(word, "any") == 0 || strcmp(word, "number") == 0 || strcmp(word, "boolean") == 0 ||
        strcmp(word, "string") == 0 || strcmp(word, "symbol") == 0 || strcmp(word, "void") == 0 ||
        strcmp(word, "unknown") == 0 || strcmp(word, "never") == 0 || strcmp(word, "object") == 0 ||
        strcmp(word, "null") == 0 || strcmp(word, "true") == 0 || strcmp(word, "false") == 0 ||
        strcmp(word, "undefined") == 0 || strcmp(word, "this") == 0;
}

static bool is_type_probe_punctuation(int32_t c) {
    return c == '%' || c == '^' || c == '!' || c == '~' || c == '@' || c == '#' || c == '*' || c == '+' || c == '-';
}

static bool scan_type_numeric_operand(TSLexer *lexer) {
    int32_t first = lexer->lookahead;
    advance(lexer);
    if (first == '0' && (lexer->lookahead == 'x' || lexer->lookahead == 'X' ||
                        lexer->lookahead == 'b' || lexer->lookahead == 'B' ||
                        lexer->lookahead == 'o' || lexer->lookahead == 'O')) {
        int32_t radix = lexer->lookahead;
        advance(lexer);
        if ((radix == 'x' || radix == 'X') ? !is_hex_digit(lexer->lookahead) :
            !(lexer->lookahead >= '0' && lexer->lookahead <= (radix == 'b' || radix == 'B' ? '1' : '7'))) return false;
        while (is_identifier_part(lexer->lookahead)) advance(lexer);
        return true;
    }
    while (is_ascii_digit(lexer->lookahead) || lexer->lookahead == '_') advance(lexer);
    if (lexer->lookahead == '.') {
        advance(lexer);
        while (is_ascii_digit(lexer->lookahead) || lexer->lookahead == '_') advance(lexer);
    }
    if (lexer->lookahead == 'e' || lexer->lookahead == 'E') {
        advance(lexer);
        if (lexer->lookahead == '+' || lexer->lookahead == '-') advance(lexer);
        if (!is_ascii_digit(lexer->lookahead)) return false;
        while (is_ascii_digit(lexer->lookahead) || lexer->lookahead == '_') advance(lexer);
    }
    if (lexer->lookahead == 'n') advance(lexer);
    return true;
}

static bool scan_type_question_tail(TSLexer *lexer, bool conditional) {
    if (lexer->lookahead != '.') return true;
    advance(lexer);
    return conditional && is_ascii_digit(lexer->lookahead);
}

static bool starts_non_identifier_type_operand(int32_t c) {
    return c == '(' || c == '[' || c == '{' || c == '<' || c == '\'' || c == '"' || c == '`' ||
           c == '+' || c == '-' || is_ascii_digit(c);
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

static bool scan_arrow_predefined_return_start(TSLexer *lexer) {
    while (is_whitespace(lexer->lookahead)) skip(lexer);
    lexer->mark_end(lexer);
    if (lexer->lookahead != '(') return false;
    advance(lexer);
    if (!scan_default_trivia(lexer, true, true)) return false;
    char word[16] = {0};
    if (!scan_identifier(lexer, word, sizeof(word), false) ||
        (strcmp(word, "unknown") != 0 && strcmp(word, "never") != 0 && strcmp(word, "unique") != 0)) return false;
    if (!scan_default_trivia(lexer, true, true) || lexer->lookahead != ')') return false;
    advance(lexer);
    if (!scan_default_trivia(lexer, true, false) || lexer->lookahead != '=') return false;
    advance(lexer);
    if (lexer->lookahead != '>') return false;
    lexer->result_symbol = ARROW_PREDEFINED_RETURN_START;
    return true;
}

static bool starts_keyword_heritage_generic(TSLexer *lexer) {
    if (!scan_default_trivia(lexer, true, false)) return false;
    if (!is_identifier_part(lexer->lookahead) || is_ascii_digit(lexer->lookahead)) return false;
    char word[16] = {0};
    if (!scan_identifier(lexer, word, sizeof(word), false)) return false;
    if (!((is_nonreference_type_word(word) && strcmp(word, "void") != 0) ||
          strcmp(word, "import") == 0 || strcmp(word, "keyof") == 0 ||
          strcmp(word, "readonly") == 0 || strcmp(word, "unique") == 0 || strcmp(word, "infer") == 0)) return false;
    return scan_default_trivia(lexer, true, false) && lexer->lookahead == '<';
}

static bool scan_infix_word(TSLexer *lexer, bool skip_characters) {
    char word[16] = {0};
    return scan_identifier(lexer, word, sizeof(word), skip_characters) &&
        (strcmp(word, "in") == 0 || strcmp(word, "instanceof") == 0);
}


static bool await_is_identifier(const Scanner *scanner) {
    return scanner->functions.depth ? !function_context_async(&scanner->functions) : JAVASCRIPT_SCRIPT_GOAL;
}

static bool scan_async_start(TSLexer *lexer, char *keyword, unsigned capacity, const bool *valid_symbols) {
    bool constructor = valid_symbols[CONSTRUCTOR_ASYNC_FUNCTION_START];
    if (!constructor) lexer->mark_end(lexer);
    lexer->result_symbol = constructor ? CONSTRUCTOR_ASYNC_FUNCTION_START : ASYNC_KEYWORD;
    return scan_default_trivia(lexer, false, false) &&
        (constructor ? scan_identifier(lexer, keyword, capacity, false) && strcmp(keyword, "function") == 0
                     : valid_symbols[ASYNC_KEYWORD]);
}

static bool scan_contextual_keyword(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    if ((valid_symbols[AWAIT_KEYWORD] || valid_symbols[AWAIT_IDENTIFIER] || valid_symbols[CONSTRUCTOR_ASYNC_FUNCTION_START] || valid_symbols[ASYNC_KEYWORD]) && lexer->lookahead == 'a') {
        return scan_await_or_async(scanner, lexer, valid_symbols);
    }
    if ((valid_symbols[YIELD_KEYWORD] || valid_symbols[YIELD_IDENTIFIER]) && lexer->lookahead == 'y') {
        return scan_yield(scanner, lexer, valid_symbols, false);
    }
    if (valid_symbols[LET] && !valid_symbols[SINGLE_STATEMENT_CONTEXT] && lexer->lookahead == 'l') {
        lexer->result_symbol = LET;
        return scan_let(lexer);
    }
    return false;
}

static bool scan_arrow_context_end(TSLexer *lexer, bool *can_scan_ternary, bool after_type_assertion, bool *statement_end) {
    lexer->mark_end(lexer);
    bool saw_newline = false;
    bool scanned_comment = false;
    if (!scan_expression_trivia(lexer, &saw_newline, &scanned_comment)) return false;
    *can_scan_ternary = !scanned_comment && lexer->lookahead == '?';
    switch (lexer->lookahead) {
        case '(': case '[': case '`':
            *statement_end = saw_newline && after_type_assertion;
            return *statement_end;
        case '?': case '=': case '*': case '%':
        case '<': case '>': case '^': case '|': case '&': return false;
        case '!': advance(lexer); return saw_newline && lexer->lookahead != '=';
        case '.': advance(lexer); return saw_newline && is_ascii_digit(lexer->lookahead);
        case '+': case '-': {
            int32_t sign = lexer->lookahead;
            advance(lexer);
            return saw_newline && lexer->lookahead == sign;
        }
        case 'i':
            return !scan_infix_word(lexer, false);
        case ';': case ',': case ':': case ')': case ']': case '}': return true;
        default: return lexer->eof(lexer) || saw_newline;
    }
}

static bool scan_expression_trivia(TSLexer *lexer, bool *saw_newline, bool *scanned_comment) {
    for (;;) {
        while (is_whitespace(lexer->lookahead)) {
            *saw_newline |= is_line_terminator(lexer->lookahead);
            skip(lexer);
        }
        if (lexer->lookahead != '/') {
            break;
        }
        if (scanned_comment) *scanned_comment = true;
        skip(lexer);
        if (lexer->lookahead == '/') {
            while (!lexer->eof(lexer) && !is_line_terminator(lexer->lookahead)) {
                skip(lexer);
            }
        } else if (lexer->lookahead == '*') {
            skip(lexer);
            scan_block_comment(lexer, saw_newline, true);
        } else {
            return false;
        }
    }
    return true;
}

static bool scan_function_start(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    bool generator = valid_symbols[GENERATOR_FUNCTION_START] || valid_symbols[ASYNC_GENERATOR_FUNCTION_START];
    bool signature = valid_symbols[FUNCTION_SIGNATURE_START] || valid_symbols[ASYNC_FUNCTION_SIGNATURE_START];
    bool body = valid_symbols[SYNC_FUNCTION_START] || valid_symbols[ASYNC_FUNCTION_START];
    bool opener = lexer->lookahead == '(' || lexer->lookahead == '<' || (generator && lexer->lookahead == '{');
    if (!body && (!(opener && (generator || signature)) || valid_symbols[CALL_ARGUMENTS_CONTEXT])) return false;
    bool async = valid_symbols[ASYNC_FUNCTION_START] || valid_symbols[ASYNC_GENERATOR_FUNCTION_START] || valid_symbols[ASYNC_FUNCTION_SIGNATURE_START];
    if (!function_context_enter(&scanner->functions, async, generator)) return false;
    lexer->mark_end(lexer);
    static const TSSymbol symbols[][2] = {
        {SYNC_FUNCTION_START, ASYNC_FUNCTION_START},
        {FUNCTION_SIGNATURE_START, ASYNC_FUNCTION_SIGNATURE_START},
        {GENERATOR_FUNCTION_START, ASYNC_GENERATOR_FUNCTION_START},
    };
    lexer->result_symbol = symbols[generator ? 2 : signature ? 1 : 0][async];
    return true;
}

static bool finish_function_context(Scanner *scanner, TSLexer *lexer, TSSymbol symbol);

static bool scan_method_signature_end(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    lexer->mark_end(lexer);
    bool saw_newline = false;
    if (!scan_expression_trivia(lexer, &saw_newline, NULL)) return false;
    if (lexer->lookahead == ';' || lexer->lookahead == ',' || lexer->lookahead == '}' || lexer->eof(lexer)) {
        return finish_function_context(scanner, lexer, METHOD_SIGNATURE_END);
    }
    if (lexer->lookahead == '|') {
        advance(lexer);
        return lexer->lookahead == '}' && finish_function_context(scanner, lexer, METHOD_SIGNATURE_END);
    }
    if (!saw_newline) return false;
    if (lexer->lookahead == ':' || lexer->lookahead == '{') return false;
    bool annotated = valid_symbols[ANNOTATED_SIGNATURE_CONTEXT];
    if (annotated) {
        switch (lexer->lookahead) {
            case '&': case '?': case '=': return false;
            case '.':
                advance(lexer);
                return is_ascii_digit(lexer->lookahead) && finish_function_context(scanner, lexer, METHOD_SIGNATURE_END);
        }
    }
    return finish_function_context(scanner, lexer, METHOD_SIGNATURE_END);
}

static bool scan_function_context(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    if (scan_function_start(scanner, lexer, valid_symbols)) return true;
    if (valid_symbols[FUNCTION_CONTEXT_END]) {
        lexer->mark_end(lexer);
        if (scanner->automatic_semicolon_pending && valid_symbols[ARROW_FUNCTION_BLOCK_CONTINUATION]) {
            bool saw_newline = false;
            scan_expression_trivia(lexer, &saw_newline, NULL);
            if (lexer->lookahead == ':' || lexer->lookahead == '}' || lexer->lookahead == ')' || lexer->lookahead == ']') {
                scanner->automatic_semicolon_pending = false;
                lexer->result_symbol = ARROW_FUNCTION_BLOCK_CONTINUATION;
                return true;
            }
        }
        if (valid_symbols[ARROW_FUNCTION_BLOCK_END]) {
            bool scanned_content = false;
            bool before_line_break = false;
            if (scan_automatic_semicolon(lexer, valid_symbols, !valid_symbols[LOGICAL_OR], true, LINE_BREAK_BY_NEXT_TOKEN, &scanned_content, &before_line_break, false)) {
                scanner->automatic_semicolon_pending = true;
                lexer->result_symbol = ARROW_FUNCTION_BLOCK_END;
                return true;
            }
        }
        return finish_function_context(scanner, lexer, FUNCTION_CONTEXT_END);
    }
    return false;
}

static bool finish_function_context(Scanner *scanner, TSLexer *lexer, TSSymbol symbol) {
    function_context_leave(&scanner->functions);
    lexer->result_symbol = symbol;
    return true;
}

static bool scan_function_signature_end(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    lexer->mark_end(lexer);
    bool saw_newline = false;
    if (!scan_expression_trivia(lexer, &saw_newline, NULL)) {
        return finish_function_context(scanner, lexer, FUNCTION_SIGNATURE_END);
    }
    if (lexer->lookahead == ':' || lexer->lookahead == '{') return false;
    bool annotated = valid_symbols[ANNOTATED_SIGNATURE_CONTEXT];
    if (annotated && !valid_symbols[BARE_ASSERTION_CONTEXT]) {
        switch (lexer->lookahead) {
            case '&': case '|': case '?': case '=': return false;
            case '[': case '<': return saw_newline && finish_function_context(scanner, lexer, FUNCTION_SIGNATURE_END);
            case '.':
                advance(lexer);
                return saw_newline && is_ascii_digit(lexer->lookahead) && finish_function_context(scanner, lexer, FUNCTION_SIGNATURE_END);
        }
    }
    if (is_identifier_part(lexer->lookahead)) {
        if (!saw_newline) return false;
    }
    return finish_function_context(scanner, lexer, FUNCTION_SIGNATURE_END);
}

static inline bool external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
    Scanner *scanner = (Scanner *)payload;

    if (valid_symbols[IMPORT_TYPE_ARGUMENTS_START] && !valid_symbols[ERROR_RECOVERY]) {
        lexer->mark_end(lexer);
        if (!scan_default_trivia(lexer, true, false) || lexer->lookahead != ')') return false;
        advance(lexer);
        if (!scan_default_trivia(lexer, false, false) || lexer->lookahead != '<') return false;
        advance(lexer);
        if (lexer->lookahead == '=' || lexer->lookahead == '!') return false;
        lexer->result_symbol = IMPORT_TYPE_ARGUMENTS_START;
        return true;
    }

    if (!(valid_symbols[TEMPLATE_CHARS] && valid_symbols[AUTOMATIC_SEMICOLON])) {
        if (valid_symbols[FUNCTION_SIGNATURE_END]) return scan_function_signature_end(scanner, lexer, valid_symbols);
        if (valid_symbols[METHOD_SIGNATURE_END]) return scan_method_signature_end(scanner, lexer, valid_symbols);
        if (scan_function_context(scanner, lexer, valid_symbols)) return true;
        if (valid_symbols[ARROW_CONTEXT_END] &&
            !(valid_symbols[LINE_BREAK_AFTER_AWAIT] && scanner->functions.depth && function_context_async(&scanner->functions))) {
            lexer->mark_end(lexer);
            bool can_scan_ternary = false;
            bool statement_end = false;
            if (!scanner->automatic_semicolon_pending && !scan_arrow_context_end(lexer, &can_scan_ternary, valid_symbols[TYPE_ASSERTION_CONTEXT], &statement_end)) {
                return valid_symbols[TERNARY_QMARK] && can_scan_ternary && scan_question_mark(lexer, valid_symbols);
            }
            scanner->automatic_semicolon_pending |= statement_end;
            function_context_leave(&scanner->functions);
            lexer->result_symbol = ARROW_CONTEXT_END;
            return true;
        }
    }


    if (valid_symbols[ARROW_PREDEFINED_RETURN_START] && !valid_symbols[ERROR_RECOVERY]) {
        while (is_whitespace(lexer->lookahead)) skip(lexer);
        if (lexer->lookahead == '(') return scan_arrow_predefined_return_start(lexer);
    }

    if (valid_symbols[REGEX_FLAGS_START] && !valid_symbols[AUTOMATIC_SEMICOLON]) {
        if (lexer->lookahead != '/') return false;
        lexer->mark_end(lexer);
        advance(lexer);
        if (lexer->lookahead < 'a' || lexer->lookahead > 'z') return false;
        lexer->result_symbol = REGEX_FLAGS_START;
        return true;
    }

    if (valid_symbols[KEYWORD_HERITAGE_ARGUMENTS_END] && !valid_symbols[ERROR_RECOVERY]) {
        while (is_whitespace(lexer->lookahead)) skip(lexer);
        if (lexer->lookahead == '>' || lexer->lookahead == '{') {
            lexer->mark_end(lexer);
            if (lexer->lookahead == '>') {
                advance(lexer);
                if (!scan_default_trivia(lexer, true, false)) return false;
                if (lexer->lookahead != ',' && lexer->lookahead != '{' && !lexer->eof(lexer)) return false;
            }
            lexer->result_symbol = KEYWORD_HERITAGE_ARGUMENTS_END;
            return true;
        }
    }

    if (!valid_symbols[ERROR_RECOVERY] && (valid_symbols[HERITAGE_TYPE_START] || valid_symbols[HERITAGE_TYPE_END])) {
        lexer->mark_end(lexer);
        if (valid_symbols[HERITAGE_TYPE_END]) {
            bool comment = false;
            if (scan_whitespace_and_comments(lexer, &comment, true, true) == REJECT) return false;
            if (lexer->lookahead != ',' && lexer->lookahead != '{' && !lexer->eof(lexer)) return false;
        }
        scanner->heritage_type_pending = valid_symbols[HERITAGE_TYPE_START] && !starts_keyword_heritage_generic(lexer);
        lexer->result_symbol = valid_symbols[HERITAGE_TYPE_START] ? HERITAGE_TYPE_START : HERITAGE_TYPE_END;
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
        valid_symbols[AUTOMATIC_SEMICOLON]) {
        scanner->automatic_semicolon_pending = false;
        lexer->result_symbol = AUTOMATIC_SEMICOLON;
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
        return scan_yield(scanner, lexer, valid_symbols, true);
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
        if (!ret && !scanned_content && (valid_symbols[TERNARY_QMARK] || valid_symbols[COMMENT_OPTIONAL_PARAMETER_MARKER]) && lexer->lookahead == '?') {
            return scan_question_mark(lexer, valid_symbols);
        }
        return ret;
    }

    if ((valid_symbols[AWAIT_OPERAND_END] && !valid_symbols[LINE_BREAK_AFTER_AWAIT]) ||
        valid_symbols[RESOURCE_BINDING_START] || valid_symbols[RESOURCE_BINDING_CONTINUATION] ||
        valid_symbols[PLAIN_RESOURCE_FOR_OF_CONTEXT]) {
        if (valid_symbols[COMPLETED_ARROW_FUNCTION]) {
            return (valid_symbols[TERNARY_QMARK] || valid_symbols[COMMENT_OPTIONAL_PARAMETER_MARKER]) && scan_question_mark(lexer, valid_symbols);
        }
        bool statement_end = false;
        bool ret = scan_expression_end(lexer, false, &statement_end, valid_symbols);
        scanner->automatic_semicolon_pending |= statement_end;
        return ret;
    }

    if (valid_symbols[AUTOMATIC_SEMICOLON] || valid_symbols[FUNCTION_SIGNATURE_AUTOMATIC_SEMICOLON] ||
        valid_symbols[TYPE_MEMBER_SEMICOLON]) {
        bool scanned_content = false;
        LineBreakRule rule = LINE_BREAK_BY_NEXT_TOKEN;
        if (valid_symbols[LINE_BREAK_AFTER_AWAIT]) {
            rule = scanner->functions.depth && function_context_async(&scanner->functions) ? LINE_BREAK_AWAIT_OPERAND : LINE_BREAK_AFTER_AWAIT_KEYWORD;
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
        bool ret = scan_automatic_semicolon(lexer, valid_symbols, !valid_symbols[LOGICAL_OR], false, rule, &scanned_content, &before_line_break, false);
        if (ret && valid_symbols[TYPE_MEMBER_SEMICOLON]) lexer->result_symbol = TYPE_MEMBER_SEMICOLON;
        if (ret && valid_symbols[STATEMENT_BOUNDARY] && !valid_symbols[NAMESPACE_EXPRESSION_END] && lexer->result_symbol == AUTOMATIC_SEMICOLON) {
            lexer->result_symbol = STATEMENT_BOUNDARY;
        }
        if (!ret && !scanned_content && (valid_symbols[TERNARY_QMARK] || valid_symbols[COMMENT_OPTIONAL_PARAMETER_MARKER]) && lexer->lookahead == '?') {
            return scan_question_mark(lexer, valid_symbols);
        }
        if (!ret && before_line_break && !scanned_content && valid_symbols[GLOBAL_DECLARATION_START] &&
            !valid_symbols[ERROR_RECOVERY] && (lexer->lookahead == 'g' || lexer->lookahead == '\\')) {
            return scan_global_declaration_start(lexer);
        }
        if (!ret && !scanned_content && (lexer->lookahead == '(' || lexer->lookahead == '<' || lexer->lookahead == '{') && scan_function_context(scanner, lexer, valid_symbols)) return true;
        if (!ret && !scanned_content && valid_symbols[HTML_COMMENT] && !valid_symbols[LOGICAL_OR] &&
            !valid_symbols[ESCAPE_SEQUENCE] && !valid_symbols[REGEX_PATTERN] &&
            (lexer->lookahead == '<' || lexer->lookahead == '-')) {
            return scan_html_comment(lexer);
        }
        if (!ret && !scanned_content && valid_symbols[AWAIT_YIELD_IDENTIFIER] && valid_symbols[LINE_BREAK_AFTER_AWAIT] && lexer->lookahead == 'y') {
            return scan_yield(scanner, lexer, valid_symbols, true);
        }
        if (!ret && !scanned_content && (valid_symbols[AWAIT_KEYWORD] || valid_symbols[AWAIT_IDENTIFIER] || valid_symbols[ASYNC_KEYWORD]) && lexer->lookahead == 'a') {
            return scan_contextual_keyword(scanner, lexer, valid_symbols);
        }
        if (!ret && !scanned_content && valid_symbols[LET] && !valid_symbols[SINGLE_STATEMENT_CONTEXT] && lexer->lookahead == 'l') {
            lexer->result_symbol = LET;
            return scan_let(lexer);
        }
        if (!ret && !scanned_content && scan_contextual_keyword(scanner, lexer, valid_symbols)) return true;
        return ret;
    }

    if ((valid_symbols[TYPE_REFERENCE_ARGUMENTS_START] || valid_symbols[UNQUALIFIED_TYPE_REFERENCE_ARGUMENTS_START] || valid_symbols[ABSTRACT_CONSTRUCTOR_PREFIX] || valid_symbols[CONDITIONAL_PREDEFINED_PARAMETER_NAME] ||
         ((valid_symbols[PREDEFINED_PARAMETER_NAME] || valid_symbols[PREDEFINED_ANNOTATED_NAME]) && (lexer->lookahead == 'u' || lexer->lookahead == 'n'))) && !valid_symbols[ERROR_RECOVERY]) {
        bool result = scan_type_reference_arguments_start(lexer, valid_symbols, scanner->heritage_type_pending);
        if (result && lexer->result_symbol != ABSTRACT_CONSTRUCTOR_PREFIX &&
            lexer->result_symbol != PREDEFINED_PARAMETER_NAME &&
            lexer->result_symbol != PREDEFINED_ANNOTATED_NAME &&
            lexer->result_symbol != CONDITIONAL_PREDEFINED_PARAMETER_NAME) scanner->heritage_type_pending = false;
        return result;
    }

    if (valid_symbols[AWAIT_YIELD_IDENTIFIER] && valid_symbols[LINE_BREAK_AFTER_AWAIT]) {
        while (is_whitespace(lexer->lookahead)) {
            skip(lexer);
        }
        if (lexer->lookahead == 'y') {
            return scan_yield(scanner, lexer, valid_symbols, true);
        }
    }

    while (is_whitespace(lexer->lookahead)) {
        skip(lexer);
    }
    if (valid_symbols[GLOBAL_DECLARATION_START] && !valid_symbols[ERROR_RECOVERY] &&
        (lexer->lookahead == 'g' || lexer->lookahead == '\\')) {
        return scan_global_declaration_start(lexer);
    }
    if ((valid_symbols[AWAIT_KEYWORD] || valid_symbols[AWAIT_IDENTIFIER] || valid_symbols[ASYNC_KEYWORD]) && lexer->lookahead == 'a') {
        return scan_contextual_keyword(scanner, lexer, valid_symbols);
    }
    if ((lexer->lookahead == '(' || lexer->lookahead == '<' || lexer->lookahead == '{') && scan_function_context(scanner, lexer, valid_symbols)) return true;
    if ((valid_symbols[TERNARY_QMARK] || valid_symbols[COMMENT_OPTIONAL_PARAMETER_MARKER]) && lexer->lookahead == '?') {
        return scan_question_mark(lexer, valid_symbols);
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
    return scan_contextual_keyword(scanner, lexer, valid_symbols);
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
    return scan_default_trivia_with_line_break(lexer, allow_line_breaks, html_comments, NULL);
}

static bool scan_default_trivia_with_line_break(TSLexer *lexer, bool allow_line_breaks, bool html_comments, bool *line_break) {
    if (line_break) *line_break = false;
    for (;;) {
        while (is_whitespace(lexer->lookahead)) {
            if (is_line_terminator(lexer->lookahead)) {
                if (!allow_line_breaks) return false;
                if (line_break) *line_break = true;
            }
            advance(lexer);
        }
        if (lexer->lookahead == '/') {
            advance(lexer);
            if (lexer->lookahead == '*') {
                advance(lexer);
                bool closed = false;
                while (!lexer->eof(lexer)) {
                    if (is_line_terminator(lexer->lookahead)) {
                        if (!allow_line_breaks) return false;
                        if (line_break) *line_break = true;
                    }
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
