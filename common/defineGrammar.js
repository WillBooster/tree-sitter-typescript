// oxlint-disable unicorn/prefer-module -- This package is CommonJS, so tree-sitter loads the grammar as CommonJS.
const JavaScript = require('@willbooster/tree-sitter-javascript/grammar');

// Words that are keywords only in some positions and identifiers elsewhere, besides the JavaScript grammar's.
const TYPESCRIPT_CONTEXTUAL_KEYWORDS = [
  'accessor',
  'declare',
  'global',
  'namespace',
  'type',
  'public',
  'private',
  'protected',
  'override',
  'readonly',
  'module',
  'any',
  'number',
  'boolean',
  'string',
  'symbol',
  'object',
  'out',
  'new',
];

// Every primary expression but a `new` without arguments reduces to `_type_arguments_target` before
// `primary_expression`, so the JavaScript grammar's precedences and conflicts for `primary_expression` take effect only
// on `_type_arguments_target`.
function withTypeArgumentsTarget($, lists) {
  return lists.map((list) =>
    list.map((entry) =>
      entry.type === 'SYMBOL' && entry.name === 'primary_expression' ? $._type_arguments_target : entry
    )
  );
}

// Dynamic precedences for the readings of `<` and `>` that GLR keeps where TypeScript's parser, which tries type
// arguments first and keeps them only before what may follow them (see `scan_type_arguments_end` in scanner.h), reads
// one way. Comparisons have 0.
const DYNAMIC_PRECEDENCE = {
  // The type arguments of a call, a tagged template, or a `new`: they also outweigh comparisons that contain
  // instantiation expressions (`f<A<B> | C>(x)`) and an extends clause's type arguments in a misreading
  // (`class C extends f<A<B>, D>(x) {}`).
  TYPE_ARGUMENTS: 3,
  // An extends clause's type arguments, which TypeScript also gives the clause where an instantiation expression could
  // take them (`class C extends B<T>` before a line break and `{`).
  EXTENDS_TYPE_ARGUMENTS: 2,
  // An instantiation expression whose type arguments TypeScript keeps before what may start an expression, which
  // comparisons could then read as their right operand: after a line break (`a<B>` before a line break and `c`) or
  // before a `/`.
  INSTANTIATION_BEFORE_EXPRESSION: 1,
  // An instantiation expression elsewhere, so that comparisons containing it lose to an enclosing generic call.
  INSTANTIATION: -1,
  // A leading `|` or `&` in a type, which TypeScript allows only at the start of a type: `a < b || c > (d)` compares
  // rather than calling `a` with `b | | c`.
  LEADING_TYPE_OPERATOR: -4,
};

module.exports = function defineGrammar(dialect) {
  return grammar(JavaScript, {
    name: dialect,

    externals: ($, previous) => [
      ...previous,
      $._function_signature_automatic_semicolon,
      $._type_arguments_end,
      $._type_arguments_end_before_expression,
      $._new_type_arguments_end,
      $._global_declaration_start,
      $._global_declaration_end,
      $.__error_recovery,
    ],

    supertypes: ($, previous) => [...previous, $.type, $.primary_type],

    precedences: ($, previous) => [
      ...withTypeArgumentsTarget($, previous),
      ['call', 'instantiation', 'unary', 'binary', $.await_expression, $.arrow_function],
      // A type assertion's operand takes the member accesses and subscripts that follow it, also after an instantiation
      // expression (`<T>a<B>` before a line break and `[0]`).
      ['member', 'unary'],
      ['extends', 'instantiation'],
      ['new', 'generic_call', 'instantiation', 'unary', 'binary'],
      // `as` and `satisfies` bind like the relational operators: looser than `**`, `*`, `+`, and `<<`, and tighter than
      // `==`, `&`, `&&`, `||`, and `??`.
      [
        'binary_exp',
        'binary_times',
        'binary_plus',
        'binary_shift',
        'binary_relation',
        'binary',
        'binary_equality',
        'bitwise_and',
        'bitwise_xor',
        'bitwise_or',
        'logical_and',
        'logical_or',
        'ternary',
      ],
      [
        $.intersection_type,
        $.union_type,
        $.conditional_type,
        $.function_type,
        'binary',
        $.type_predicate,
        $.readonly_type,
      ],
      [$.mapped_type_clause, $._type_arguments_target],
      [$.accessibility_modifier, $._type_arguments_target],
      ['unary_void', $.expression],
      [$.extends_clause, $._type_arguments_target],
      ['unary', 'assign'],
      ['declaration', $.expression],
      [$.predefined_type, $.unary_expression],
      [$.type, $.flow_maybe_type],
      [$.tuple_type, $.array_type, $.pattern, $.type],
      [$.readonly_type, $.pattern],
      [$.readonly_type, $._type_arguments_target],
      [$.type_query, $.subscript_expression, $.expression],
      [$.type_query, $._type_query_subscript_expression],
      [$.nested_type_identifier, $.generic_type, $.primary_type, $.lookup_type, $.index_type_query, $.type],
      // A qualified type name takes every `.` and name that follow it: `x as a.b.C` is not `(x as a.b).C`.
      [$.nested_identifier, $._in_nested_identifier, $.nested_type_identifier],
      [$.as_expression, $.satisfies_expression, $.primary_type],
      [$._type_query_member_expression, $.member_expression],
      [$.member_expression, $._type_query_member_expression_in_type_annotation],
      [$._type_query_member_expression, $._type_arguments_target],
      [$._type_query_subscript_expression, $.subscript_expression],
      [$._type_query_subscript_expression, $._type_arguments_target],
      [$._type_query_call_expression, $._type_arguments_target],
      [$._type_query_instantiation_expression, $._type_arguments_target],
      [$.type_query, $._type_arguments_target],
      [$.override_modifier, $._type_arguments_target],
      [$.decorator_call_expression, $.decorator],
      [$.literal_type, $.pattern],
      [$.predefined_type, $.pattern],
      [$.call_expression, $._type_query_call_expression],
      [$.call_expression, $._type_query_call_expression_in_type_annotation],
      [$.new_expression, $._type_arguments_target],
      [$.meta_property, $._type_arguments_target],
      [$.construct_signature, $._property_name],
    ],

    conflicts: ($, previous) => [
      ...withTypeArgumentsTarget($, previous),
      [$._type_arguments_target, $.using_declaration],
      [$._type_arguments_target, $._for_header, $._for_using_declaration],
      [$._for_header, $._binding_identifier],
      [$._field_name, $._property_name],
      [$._property_name, $.public_field_definition],

      // This appears to be necessary to parse a parenthesized class expression
      [$.class],

      [$.nested_identifier, $.nested_type_identifier, $._type_arguments_target],

      [$._call_signature, $.function_type],
      [$._call_signature, $.constructor_type],

      [$._type_arguments_target, $._parameter_name],
      [$._type_arguments_target, $._parameter_name, $.primary_type],
      [$._type_arguments_target, $.literal_type],
      [$._type_arguments_target, $.literal_type, $.rest_pattern],
      [$._type_arguments_target, $.predefined_type, $.rest_pattern],
      [$._type_arguments_target, $.primary_type],
      [$._type_arguments_target, $.generic_type],
      [$._type_arguments_target, $.predefined_type],
      [$._type_arguments_target, $.pattern, $.primary_type],
      [$._parameter_name, $.primary_type],
      [$.pattern, $.primary_type],

      [$._tuple_label, $.primary_type],
      [$._tuple_label, $.literal_type],
      [$._tuple_label, $.index_type_query],
      [$._tuple_label, $.readonly_type],
      [$._tuple_label, $.predefined_type],
      [$.rest_pattern, $.primary_type, $._type_arguments_target],

      [$.object, $.object_type],
      [$.object, $.object_pattern, $.object_type],
      [$.object, $.object_pattern, $._property_name],
      [$.object_pattern, $.object_type],
      [$.object_pattern, $.object_type],

      [$.array, $.tuple_type],
      [$.array, $.array_pattern, $.tuple_type],
      [$.array_pattern, $.tuple_type],

      [$.template_literal_type, $.template_string],
      ...(dialect === 'typescript'
        ? [[$.primary_type, $.type_parameter]]
        : [
            [$.jsx_opening_element, $.type_parameter],
            [$.jsx_opening_element, $.jsx_self_closing_element, $.type_parameter],
            [$.jsx_namespace_name, $.primary_type],
          ]),
      [
        $.primary_expression,
        $.call_expression,
        $._argumentless_new_expression,
        $.new_expression,
        $.instantiation_expression,
      ],
      [$.primary_expression, $.call_expression, $.instantiation_expression],
      [$.expression, $.call_expression],
    ],

    inline: ($, previous) => [
      ...previous.filter((rule) => !['_formal_parameter', '_call_signature'].includes(rule.name)),
      $._type_identifier,
      $._type_reference_identifier,
      $._jsx_start_opening_element,
    ],

    rules: {
      // A field named `get`, `set`, or `static` is told apart from a member that the word modifies by the line-break
      // sentinels allowed right after the name, as in the JavaScript grammar's field_definition. They are not allowed
      // after a type annotation, which may continue on the next line.
      public_field_definition: ($) =>
        seq(
          repeat(field('decorator', $.decorator)),
          optional(
            choice(
              seq('declare', optional($.accessibility_modifier)),
              seq($.accessibility_modifier, optional('declare'))
            )
          ),
          choice(
            seq(
              choice(
                seq(optional('static'), optional($.override_modifier), optional('readonly')),
                seq(optional('abstract'), optional('readonly')),
                seq(optional('readonly'), optional('abstract')),
                seq(optional('static'), optional($.override_modifier), 'accessor'),
                seq('abstract', optional($.override_modifier), 'accessor')
              ),
              choice(
                seq(
                  field('name', $._field_name),
                  choice(
                    optional(choice($._initializer, $._line_break_after_field)),
                    seq($._field_annotations, optional($._initializer))
                  )
                ),
                // A line break after `get` or `set` continues a getter or setter. Allowing both sentinels here tells
                // the scanner that a `*` on the next line cannot continue the member, unlike after `static`.
                seq(
                  field('name', alias(choice('get', 'set'), $.property_identifier)),
                  choice(
                    optional(choice($._initializer, $._line_break_after_modifier, $._line_break_after_field)),
                    seq($._field_annotations, optional($._initializer))
                  )
                )
              )
            ),
            // A line break after a leading `static` continues a static member.
            seq(
              field('name', alias('static', $.property_identifier)),
              choice(
                optional(choice($._initializer, $._line_break_after_modifier)),
                seq($._field_annotations, optional($._initializer))
              )
            ),
            // After a modifier, `static` is a field name, which a line break ends.
            seq(
              choice(
                seq('static', optional($.override_modifier), optional('readonly')),
                seq($.override_modifier, optional('readonly')),
                seq('readonly', optional('abstract')),
                seq('abstract', optional('readonly')),
                seq(optional('static'), optional($.override_modifier), 'accessor'),
                seq('abstract', optional($.override_modifier), 'accessor')
              ),
              field('name', alias('static', $.property_identifier)),
              choice(
                optional(choice($._initializer, $._line_break_after_field)),
                seq($._field_annotations, optional($._initializer))
              )
            )
          )
        ),

      _field_annotations: ($) =>
        choice(seq(choice('?', '!'), field('type', optional($.type_annotation))), field('type', $.type_annotation)),

      _field_name: ($, previous) =>
        choice(previous, alias(choice(...TYPESCRIPT_CONTEXTUAL_KEYWORDS), $.property_identifier)),

      // override original catch_clause, add optional type annotation
      catch_clause: ($) =>
        seq(
          'catch',
          optional(
            seq(
              '(',
              field('parameter', choice($.identifier, $._destructuring_pattern)),
              optional(
                // only types that resolve to 'any' or 'unknown' are supported
                // by the language but it's simpler to accept any type here.
                field('type', $.type_annotation)
              ),
              ')'
            )
          ),
          field('body', $.statement_block)
        ),

      call_expression: ($) =>
        choice(
          prec('call', seq(field('function', choice($.expression, $.import)), field('arguments', $.arguments))),
          // Type arguments follow a primary expression, as in TypeScript: `a + b<T>(c)` calls `b`. Where comparisons
          // could also read the input, as in `a < b > (c)`, TypeScript reads a generic call. A tag with type arguments
          // is parsed like a generic call. Optional type arguments in the `template_call` alternative below would make
          // the parser commit to a tagged template at the `<` of `f<T>(x)`.
          prec.dynamic(
            DYNAMIC_PRECEDENCE.TYPE_ARGUMENTS,
            prec(
              'generic_call',
              seq(
                field('function', $._type_arguments_target),
                field('type_arguments', $.type_arguments),
                field('arguments', choice($.arguments, $.template_string))
              )
            )
          ),
          prec('template_call', seq(field('function', $.primary_expression), field('arguments', $.template_string))),
          prec(
            'member',
            seq(
              field('function', $.primary_expression),
              field('optional_chain', $.optional_chain),
              field('type_arguments', optional($.type_arguments)),
              field('arguments', $.arguments)
            )
          ),
          // An instantiation expression is no primary expression, but it may be called through `?.` (`f<T>?.(x)`). Without
          // a precedence, GLR also keeps the reading in which it is the object of `?.[0]` or `?.x`.
          seq(
            field('function', $.instantiation_expression),
            field('optional_chain', $.optional_chain),
            field('type_arguments', optional($.type_arguments)),
            field('arguments', $.arguments)
          )
        ),

      new_expression: ($, previous) =>
        choice(
          previous,
          prec.dynamic(
            DYNAMIC_PRECEDENCE.TYPE_ARGUMENTS,
            prec(
              'new',
              seq(
                'new',
                field('constructor', $._type_arguments_target),
                field('type_arguments', $.type_arguments),
                field('arguments', $.arguments)
              )
            )
          )
        ),

      // TypeScript reads `new A<B>c` as comparisons, but `new A<B>` before a line break and `c` as a `new` with type
      // arguments, which also take precedence over an extends clause's (`class C extends new A<B>, D {}`).
      _argumentless_new_expression: ($, previous) =>
        choice(
          previous,
          prec.dynamic(
            DYNAMIC_PRECEDENCE.TYPE_ARGUMENTS,
            seq(
              'new',
              field('constructor', $._type_arguments_target),
              field('type_arguments', $.type_arguments),
              $._new_type_arguments_end
            )
          )
        ),

      assignment_expression: ($) =>
        prec.right(
          'assign',
          seq(field('left', choice($.parenthesized_expression, $._lhs_expression)), '=', field('right', $.expression))
        ),

      _augmented_assignment_lhs: ($, previous) => choice(previous, $.non_null_expression),

      _lhs_expression: ($, previous) => choice(previous, $.non_null_expression),

      primary_expression: ($) =>
        choice($._type_arguments_target, alias($._argumentless_new_expression, $.new_expression)),

      // The primary expressions that type arguments in an expression may follow: TypeScript gives the type arguments
      // after `new A` to the `new` (`new A<T>()`, `new new A<T>()`), so a `new` without arguments takes none.
      _type_arguments_target: ($) => {
        const members = JavaScript.grammar.rules.primary_expression.members.filter(
          (member) => member.type !== 'ALIAS' || member.content.name !== '_argumentless_new_expression'
        );
        return choice(...members, $.non_null_expression);
      },

      // If the dialect is regular typescript, we exclude JSX expressions and
      // include type assertions. If the dialect is TSX, we do the opposite.
      expression: ($, previous) => {
        const choices = [$.as_expression, $.satisfies_expression, $.instantiation_expression, $.internal_module];
        const members = previous.members;

        if (dialect === 'typescript') {
          choices.push($.type_assertion);
          choices.push(...members.filter((member) => member.name !== '_jsx_element'));
        } else if (dialect === 'tsx') {
          choices.push(...members);
        } else {
          throw new Error(`Unknown dialect ${dialect}`);
        }

        return choice(...choices);
      },

      _jsx_identifier: ($, previous) => choice(previous, alias(choice('in', 'out'), $.identifier)),

      nested_identifier: ($) =>
        prec(
          'member',
          seq(
            field(
              'object',
              choice(
                reserved('properties', $.identifier),
                alias('out', $.identifier),
                alias($.nested_identifier, $.member_expression)
              )
            ),
            ...nestedIdentifierTail($)
          )
        ),

      _in_nested_identifier: ($) =>
        prec(
          'member',
          seq(
            field('object', choice(alias('in', $.identifier), alias($._in_nested_identifier, $.member_expression))),
            ...nestedIdentifierTail($)
          )
        ),

      _jsx_element_name: ($, previous) => choice(previous, alias($._in_nested_identifier, $.member_expression)),

      _jsx_start_opening_element: ($) =>
        seq(
          '<',
          optional(
            seq(
              choice(
                field('name', choice($._jsx_identifier, $.jsx_namespace_name)),
                seq(
                  field(
                    'name',
                    choice(
                      $._jsx_identifier,
                      alias($.nested_identifier, $.member_expression),
                      alias($._in_nested_identifier, $.member_expression)
                    )
                  ),
                  field('type_arguments', optional($.type_arguments))
                )
              ),
              repeat(field('attribute', $._jsx_attribute))
            )
          )
        ),

      // This rule is only referenced by expression when the dialect is 'tsx'
      jsx_opening_element: ($) => prec.dynamic(-1, seq($._jsx_start_opening_element, '>')),

      // tsx only. See jsx_opening_element.
      jsx_self_closing_element: ($) => prec.dynamic(-1, seq($._jsx_start_opening_element, '/>')),

      export_specifier: (_, previous) => seq(optional(choice('type', 'typeof')), previous),

      _local_export_specifier: (_, previous) => seq(optional(choice('type', 'typeof')), previous),

      _import_identifier: ($) => choice($.identifier, alias('type', $.identifier)),

      import_specifier: ($) =>
        seq(
          optional(choice('type', 'typeof')),
          choice(
            field('name', $._import_identifier),
            seq(
              field('name', choice($._module_export_name, alias('type', $.identifier))),
              'as',
              field('alias', $._import_identifier)
            )
          )
        ),

      import_attribute: ($) => seq(choice('with', 'assert'), $.object),

      import_clause: ($) =>
        choice(
          $.namespace_import,
          $.named_imports,
          seq($._import_identifier, optional(seq(',', choice($.namespace_import, $.named_imports))))
        ),

      import_statement: ($) =>
        seq(
          'import',
          optional(choice('type', 'typeof')),
          choice(seq($.import_clause, $._from_clause), $.import_require_clause, field('source', $.string)),
          optional(choice($.import_attribute, $._line_break_before_attributes)),
          $._semicolon
        ),

      export_statement: ($, previous) =>
        choice(
          previous,
          seq('export', field('declaration', alias($.global_declaration, $.internal_module))),
          seq('export', 'type', $.export_clause, optional($._from_clause), $._semicolon),
          seq('export', 'type', choice('*', $.namespace_export), $._from_clause, $._semicolon),
          seq('export', '=', $.expression, $._semicolon),
          seq('export', 'as', 'namespace', $.identifier, $._semicolon)
        ),

      // ECMAScript binds only identifiers in a using declaration, so `using [a] = b` assigns to a subscript of a
      // variable named `using`.
      using_declaration: ($) =>
        seq(
          field('kind', choice('using', seq('await', 'using'))),
          commaSep1(alias($._using_declarator, $.variable_declarator)),
          $._semicolon
        ),

      _for_using_declaration: ($) =>
        seq(
          field('kind', choice('using', seq('await', 'using'))),
          commaSep1(alias($._using_declarator, $.variable_declarator)),
          ';'
        ),

      _using_declarator: ($) =>
        seq(field('name', $._binding_identifier), field('type', optional($.type_annotation)), optional($._initializer)),

      // After a declaration keyword that may also be an identifier (`let`, `using`), the lexer reads `of`, `as`, and
      // `satisfies` as the keywords that could follow that identifier, and every declaration shares that lexer state.
      _binding_identifier: ($) => choice($.identifier, alias(choice('of', 'as', 'satisfies'), $.identifier)),

      _for_header: ($) =>
        seq(
          '(',
          choice(
            field('left', choice($._lhs_expression, $.parenthesized_expression)),
            seq(
              field('kind', 'var'),
              field('left', choice($._binding_identifier, $._destructuring_pattern)),
              optional($._initializer)
            ),
            seq(
              field('kind', choice('let', 'const')),
              field('left', choice($._binding_identifier, $._destructuring_pattern))
            ),
            seq(field('kind', choice('using', seq('await', 'using'))), field('left', $._binding_identifier))
          ),
          field('operator', choice('in', 'of')),
          field('right', $._expressions),
          ')'
        ),

      // TypeScript parses a postfix `!` as part of a member access chain, so `new A!()` constructs `A!`.
      non_null_expression: ($) => prec('member', seq($.primary_expression, '!')),

      variable_declarator: ($) =>
        choice(
          seq(
            field('name', choice($._binding_identifier, $._destructuring_pattern)),
            // The line-break sentinel applies only right after the name: a type may continue on the next line.
            choice(
              optional(choice($._initializer, $._line_break_after_binding)),
              seq(field('type', $.type_annotation), optional($._initializer))
            )
          ),
          prec('declaration', seq(field('name', $._binding_identifier), '!', field('type', $.type_annotation)))
        ),

      method_signature: ($) =>
        seq(
          optional($.accessibility_modifier),
          optional('static'),
          optional($.override_modifier),
          optional('readonly'),
          optional('async'),
          optional(choice('get', 'set', '*')),
          field('name', $._property_name),
          optional('?'),
          $._call_signature
        ),

      abstract_method_signature: ($) =>
        seq(
          optional($.accessibility_modifier),
          'abstract',
          optional($.override_modifier),
          optional(choice('get', 'set', '*')),
          field('name', $._property_name),
          optional('?'),
          $._call_signature
        ),

      parenthesized_expression: ($) =>
        seq('(', choice(seq($.expression, field('type', optional($.type_annotation))), $.sequence_expression), ')'),

      _formal_parameter: ($) => choice($.required_parameter, $.optional_parameter),

      function_signature: ($) =>
        seq(
          optional('async'),
          'function',
          field('name', $.identifier),
          $._call_signature,
          choice($._semicolon, $._function_signature_automatic_semicolon)
        ),

      decorator: ($) =>
        seq(
          '@',
          choice(
            $.identifier,
            alias($.decorator_member_expression, $.member_expression),
            alias($.decorator_call_expression, $.call_expression),
            alias($.decorator_parenthesized_expression, $.parenthesized_expression)
          )
        ),

      decorator_call_expression: ($) =>
        prec(
          'call',
          seq(
            field(
              'function',
              choice(
                $.identifier,
                alias($.decorator_member_expression, $.member_expression),
                alias($.decorator_parenthesized_expression, $.parenthesized_expression)
              )
            ),
            optional(field('type_arguments', $.type_arguments)),
            field('arguments', $.arguments)
          )
        ),

      decorator_parenthesized_expression: ($) => seq('(', $._expressions, ')'),

      class_body: ($) =>
        seq(
          '{',
          repeat(
            choice(
              seq(repeat(field('decorator', $.decorator)), $.method_definition, optional($._semicolon)),
              // As it happens for functions, the semicolon insertion should not
              // happen if a block follows the closing paren, because then it's a
              // *definition*, not a declaration. Example:
              //     public foo()
              //     { <--- this brace made the method signature become a definition
              //     }
              // The same rule applies for functions and that's why we use
              // "_function_signature_automatic_semicolon".
              seq($.method_signature, choice($._function_signature_automatic_semicolon, ',')),
              $.class_static_block,
              seq(
                choice($.abstract_method_signature, $.index_signature, $.method_signature, $.public_field_definition),
                choice($._semicolon, ',')
              ),
              ';'
            )
          ),
          '}'
        ),

      method_definition: ($) =>
        prec.left(
          seq(
            optional($.accessibility_modifier),
            optional('static'),
            optional($.override_modifier),
            optional('readonly'),
            optional('async'),
            optional(choice('get', 'set', '*')),
            field('name', $._property_name),
            optional('?'),
            $._call_signature,
            field('body', alias($._class_member_body, $.statement_block))
          )
        ),

      statement: ($, previous) => choice(previous, alias($.global_declaration, $.internal_module)),

      declaration: ($, previous) =>
        choice(
          previous,
          $.function_signature,
          $.abstract_class_declaration,
          $.module,
          prec('declaration', $.internal_module),
          $.type_alias_declaration,
          $.enum_declaration,
          $.interface_declaration,
          $.import_alias,
          $.ambient_declaration
        ),

      type_assertion: ($) => prec.left('unary', seq($.type_arguments, $.expression)),

      as_expression: ($) => prec.left('binary', seq($.expression, 'as', choice('const', $.type))),

      satisfies_expression: ($) => prec.left('binary', seq($.expression, 'satisfies', $.type)),

      instantiation_expression: ($) => {
        const instantiation = (end) =>
          prec('instantiation', seq($._type_arguments_target, field('type_arguments', $.type_arguments), end));
        return choice(
          prec.dynamic(DYNAMIC_PRECEDENCE.INSTANTIATION, instantiation($._type_arguments_end)),
          prec.dynamic(
            DYNAMIC_PRECEDENCE.INSTANTIATION_BEFORE_EXPRESSION,
            instantiation($._type_arguments_end_before_expression)
          )
        );
      },

      class_heritage: ($) => choice(seq($.extends_clause, optional($.implements_clause)), $.implements_clause),

      import_require_clause: ($) => seq($.identifier, '=', 'require', '(', field('source', $.string), ')'),

      extends_clause: ($) => seq('extends', commaSep1($._extends_clause_single)),

      _extends_clause_single: ($) =>
        prec(
          'extends',
          choice(
            field('value', $.expression),
            prec.dynamic(
              DYNAMIC_PRECEDENCE.EXTENDS_TYPE_ARGUMENTS,
              seq(field('value', $.expression), field('type_arguments', $.type_arguments))
            )
          )
        ),

      implements_clause: ($) => seq('implements', commaSep1($.type)),

      ambient_declaration: ($) =>
        seq(
          'declare',
          choice(
            $.declaration,
            seq(alias($._global_declaration_start, 'global'), choice($.statement_block, $._global_declaration_end)),
            seq('module', '.', alias($.identifier, $.property_identifier), ':', $.type, $._semicolon)
          )
        ),

      class: ($) =>
        prec(
          'literal',
          seq(
            repeat(field('decorator', $.decorator)),
            'class',
            field('name', optional($._type_identifier)),
            field('type_parameters', optional($.type_parameters)),
            optional($.class_heritage),
            field('body', $.class_body)
          )
        ),

      abstract_class_declaration: ($) =>
        prec(
          'declaration',
          seq(
            repeat(field('decorator', $.decorator)),
            'abstract',
            'class',
            field('name', $._type_identifier),
            field('type_parameters', optional($.type_parameters)),
            optional($.class_heritage),
            field('body', $.class_body)
          )
        ),

      class_declaration: ($) =>
        prec.left(
          'declaration',
          seq(
            repeat(field('decorator', $.decorator)),
            'class',
            field('name', $._type_identifier),
            field('type_parameters', optional($.type_parameters)),
            optional($.class_heritage),
            field('body', $.class_body),
            optional($._automatic_semicolon)
          )
        ),

      module: ($) => seq('module', $._module),

      internal_module: ($) => seq('namespace', $._module),

      global_declaration: ($) =>
        seq(
          field('name', alias($._global_declaration_start, $.identifier)),
          choice(field('body', $.statement_block), $._global_declaration_end)
        ),

      _module: ($) =>
        prec.right(
          seq(
            field(
              'name',
              choice($.string, reserved('properties', $.identifier), alias('out', $.identifier), $.nested_identifier)
            ),
            // On .d.ts files "declare module foo" desugars to "declare module foo {}",
            // hence why it is optional here
            field('body', optional($.statement_block))
          )
        ),

      import_alias: ($) =>
        seq(
          'import',
          $.identifier,
          '=',
          choice($.identifier, alias('out', $.identifier), $.nested_identifier),
          $._semicolon
        ),

      nested_type_identifier: ($) =>
        prec(
          'member',
          seq(
            field(
              'module',
              choice(
                $.identifier,
                alias(choice('in', 'out'), $.identifier),
                $.nested_identifier,
                alias($._in_nested_identifier, $.nested_identifier)
              )
            ),
            '.',
            field('name', $._type_reference_identifier)
          )
        ),

      interface_declaration: ($) =>
        seq(
          'interface',
          field('name', $._type_identifier),
          field('type_parameters', optional($.type_parameters)),
          optional($.extends_type_clause),
          field('body', alias($.object_type, $.interface_body))
        ),

      extends_type_clause: ($) =>
        seq('extends', commaSep1(field('type', choice($._type_identifier, $.nested_type_identifier, $.generic_type)))),

      enum_declaration: ($) => seq(optional('const'), 'enum', field('name', $.identifier), field('body', $.enum_body)),

      enum_body: ($) =>
        seq(
          '{',
          optional(seq(sepBy1(',', choice(field('name', $._property_name), $.enum_assignment)), optional(','))),
          '}'
        ),

      enum_assignment: ($) => seq(field('name', $._property_name), $._initializer),

      type_alias_declaration: ($) =>
        seq(
          'type',
          field('name', $._type_identifier),
          field('type_parameters', optional($.type_parameters)),
          '=',
          field('value', $.type),
          $._semicolon
        ),

      accessibility_modifier: () => choice('public', 'private', 'protected'),

      override_modifier: () => 'override',

      required_parameter: ($) =>
        seq($._parameter_name, field('type', optional($.type_annotation)), optional($._initializer)),

      optional_parameter: ($) =>
        seq($._parameter_name, '?', field('type', optional($.type_annotation)), optional($._initializer)),

      _parameter_name: ($) =>
        seq(
          repeat(field('decorator', $.decorator)),
          optional($.accessibility_modifier),
          optional($.override_modifier),
          optional('readonly'),
          field('pattern', choice($.pattern, $.this))
        ),

      omitting_type_annotation: ($) => seq('-?:', $.type),
      adding_type_annotation: ($) => seq('+?:', $.type),
      opting_type_annotation: ($) => seq('?:', $.type),
      type_annotation: ($) => seq(':', $.type),

      // Oh boy
      // The issue is these special type queries need a lower relative precedence than the normal ones,
      // since these are used in type annotations whereas the other ones are used where `typeof` is
      // required beforehand. This allows for parsing of annotations such as
      // foo: import('x').y.z;
      // but was a nightmare to get working.
      _type_query_member_expression_in_type_annotation: ($) =>
        seq(
          field(
            'object',
            choice(
              $.import,
              alias($._type_query_member_expression_in_type_annotation, $.member_expression),
              alias($._type_query_call_expression_in_type_annotation, $.call_expression)
            )
          ),
          '.',
          field(
            'property',
            choice($.private_property_identifier, reserved('properties', alias($.identifier, $.property_identifier)))
          )
        ),
      _type_query_call_expression_in_type_annotation: ($) =>
        seq(
          field(
            'function',
            choice($.import, alias($._type_query_member_expression_in_type_annotation, $.member_expression))
          ),
          field('arguments', $.arguments)
        ),

      asserts: ($) => seq('asserts', choice($.type_predicate, $.identifier, alias('out', $.identifier), $.this)),

      asserts_annotation: ($) => seq(seq(':', $.asserts)),

      type: ($) =>
        choice(
          $.primary_type,
          $.function_type,
          $.readonly_type,
          $.constructor_type,
          $.infer_type,
          prec(-1, alias($._type_query_member_expression_in_type_annotation, $.member_expression)),
          prec(-1, alias($._type_query_call_expression_in_type_annotation, $.call_expression))
        ),

      tuple_parameter: ($) =>
        seq(
          field('name', choice($._tuple_label, alias($._tuple_rest_label, $.rest_pattern))),
          field('type', $.type_annotation)
        ),

      optional_tuple_parameter: ($) => seq(field('name', $._tuple_label), '?', field('type', $.type_annotation)),

      _tuple_rest_label: ($) => seq('...', choice($._tuple_label, alias('in', $.identifier))),

      _tuple_label: ($) =>
        choice(
          $.identifier,
          alias(
            choice(
              'any',
              'number',
              'boolean',
              'string',
              'symbol',
              'void',
              'unknown',
              'never',
              'object',
              'readonly',
              'out',
              'keyof',
              'infer',
              'typeof',
              'new',
              'const',
              'unique',
              'abstract',
              'import',
              'function'
            ),
            $.identifier
          ),
          alias(choice($.undefined, $.null, $.true, $.false, $.this), $.identifier)
        ),

      optional_type: ($) => seq($.type, '?'),
      rest_type: ($) => seq('...', $.type),

      _tuple_type_member: ($) =>
        choice(
          alias($.tuple_parameter, $.required_parameter),
          alias($.optional_tuple_parameter, $.optional_parameter),
          $.optional_type,
          $.rest_type,
          $.type
        ),

      constructor_type: ($) =>
        prec.left(
          seq(
            optional('abstract'),
            'new',
            field('type_parameters', optional($.type_parameters)),
            field('parameters', $.formal_parameters),
            '=>',
            field('type', $.type)
          )
        ),

      primary_type: ($) =>
        choice(
          $.parenthesized_type,
          $.predefined_type,
          $._type_reference_identifier,
          $.nested_type_identifier,
          $.generic_type,
          $.object_type,
          $.array_type,
          $.tuple_type,
          $.flow_maybe_type,
          $.type_query,
          $.index_type_query,
          alias($.this, $.this_type),
          $.existential_type,
          $.literal_type,
          $.lookup_type,
          $.conditional_type,
          $.template_literal_type,
          $.intersection_type,
          $.union_type,
          'const'
        ),

      template_type: ($) => seq('${', choice($.primary_type, $.infer_type), '}'),

      template_literal_type: ($) =>
        seq('`', repeat(choice(alias($._template_chars, $.string_fragment), $.template_type)), '`'),

      infer_type: ($) => prec.right(seq('infer', $._type_identifier, optional(seq('extends', $.type)))),

      conditional_type: ($) =>
        prec.right(
          seq(
            field('left', $.type),
            'extends',
            field('right', $.type),
            '?',
            field('consequence', $.type),
            ':',
            field('alternative', $.type)
          )
        ),

      generic_type: ($) =>
        prec(
          'call',
          seq(
            field(
              'name',
              choice(
                $._type_reference_identifier,
                $.nested_type_identifier,
                alias($._type_query_member_expression_in_type_annotation, $.member_expression)
              )
            ),
            field('type_arguments', $.type_arguments)
          )
        ),

      type_predicate: ($) =>
        seq(
          field(
            'name',
            choice(
              $.identifier,
              alias('out', $.identifier),
              $.this,
              // Sometimes tree-sitter contextual lexing is not good enough to know
              // that 'object' in ':object is foo' is really an identifier and not
              // a predefined_type, so we must explicitely list all possibilities.
              // TODO: should we use '_reserved_identifier'? Should all the element in
              // 'predefined_type' be added to '_reserved_identifier'?
              alias($.predefined_type, $.identifier)
            )
          ),
          'is',
          field('type', $.type)
        ),

      type_predicate_annotation: ($) => seq(seq(':', $.type_predicate)),

      // Type query expressions are more restrictive than regular expressions
      _type_query_member_expression: ($) =>
        seq(
          field(
            'object',
            choice(
              reserved('properties', $.identifier),
              $.this,
              alias($._type_query_subscript_expression, $.subscript_expression),
              alias($._type_query_member_expression, $.member_expression),
              alias($._type_query_call_expression, $.call_expression)
            )
          ),
          choice('.', field('optional_chain', $.optional_chain)),
          field(
            'property',
            choice($.private_property_identifier, reserved('properties', alias($.identifier, $.property_identifier)))
          )
        ),
      _type_query_subscript_expression: ($) =>
        seq(
          field(
            'object',
            choice(
              reserved('properties', $.identifier),
              $.this,
              alias($._type_query_subscript_expression, $.subscript_expression),
              alias($._type_query_member_expression, $.member_expression),
              alias($._type_query_call_expression, $.call_expression)
            )
          ),
          optional(field('optional_chain', $.optional_chain)),
          '[',
          field('index', choice($.predefined_type, $.string, $.number)),
          ']'
        ),
      _type_query_call_expression: ($) =>
        seq(
          field(
            'function',
            choice(
              $.import,
              reserved('properties', $.identifier),
              alias($._type_query_member_expression, $.member_expression),
              alias($._type_query_subscript_expression, $.subscript_expression)
            )
          ),
          field('arguments', $.arguments)
        ),
      _type_query_instantiation_expression: ($) =>
        seq(
          field(
            'function',
            choice(
              $.import,
              reserved('properties', $.identifier),
              alias($._type_query_member_expression, $.member_expression),
              alias($._type_query_subscript_expression, $.subscript_expression)
            )
          ),
          field('type_arguments', $.type_arguments)
        ),
      type_query: ($) =>
        prec.right(
          seq(
            'typeof',
            choice(
              alias($._type_query_subscript_expression, $.subscript_expression),
              alias($._type_query_member_expression, $.member_expression),
              alias($._type_query_call_expression, $.call_expression),
              alias($._type_query_instantiation_expression, $.instantiation_expression),
              reserved('properties', $.identifier),
              $.this
            )
          )
        ),

      index_type_query: ($) => seq('keyof', $.primary_type),

      lookup_type: ($) => seq($.primary_type, '[', $.type, ']'),

      mapped_type_clause: ($) =>
        seq(
          field('name', $._type_identifier),
          'in',
          field('type', $.type),
          optional(seq('as', field('alias', $.type)))
        ),

      literal_type: ($) =>
        choice(alias($._number, $.unary_expression), $.number, $.string, $.true, $.false, $.null, $.undefined),

      _number: ($) => prec.left(1, seq(field('operator', choice('-', '+')), field('argument', $.number))),

      existential_type: () => '*',

      flow_maybe_type: ($) => prec.right(seq('?', $.primary_type)),

      parenthesized_type: ($) => seq('(', $.type, ')'),

      predefined_type: () =>
        choice(
          'any',
          'number',
          'boolean',
          'string',
          'symbol',
          alias(seq('unique', 'symbol'), 'unique symbol'),
          'void',
          'unknown',
          'string',
          'never',
          'object'
        ),

      type_arguments: ($) => seq('<', commaSep1($.type), optional(','), '>'),

      object_type: ($) =>
        seq(
          choice('{', '{|'),
          optional(
            seq(
              optional(choice(',', ';')),
              sepBy1(
                choice(',', $._semicolon),
                choice(
                  $.export_statement,
                  $.property_signature,
                  $.call_signature,
                  $.construct_signature,
                  $.index_signature,
                  $.method_signature
                )
              ),
              optional(choice(',', $._semicolon))
            )
          ),
          choice('}', '|}')
        ),

      call_signature: ($) => $._call_signature,

      property_signature: ($) =>
        seq(
          optional($.accessibility_modifier),
          optional('static'),
          optional($.override_modifier),
          optional('readonly'),
          field('name', $._property_name),
          optional('?'),
          field('type', optional($.type_annotation))
        ),

      _call_signature: ($) =>
        seq(
          field('type_parameters', optional($.type_parameters)),
          field('parameters', $.formal_parameters),
          field('return_type', optional(choice($.type_annotation, $.asserts_annotation, $.type_predicate_annotation)))
        ),

      type_parameters: ($) => seq('<', commaSep1($.type_parameter), optional(','), '>'),

      type_parameter: ($) =>
        seq(
          repeat(choice('const', 'in', 'out')),
          field('name', $._type_identifier),
          field('constraint', optional($.constraint)),
          field('value', optional($.default_type))
        ),

      default_type: ($) => seq('=', $.type),

      constraint: ($) => seq(choice('extends', ':'), $.type),

      construct_signature: ($) =>
        seq(
          optional('abstract'),
          'new',
          field('type_parameters', optional($.type_parameters)),
          field('parameters', $.formal_parameters),
          field('type', optional($.type_annotation))
        ),

      index_signature: ($) =>
        seq(
          optional(seq(field('sign', optional(choice('-', '+'))), 'readonly')),
          '[',
          choice(
            seq(
              field('name', choice($.identifier, alias($._reserved_identifier, $.identifier))),
              ':',
              field('index_type', $.type)
            ),
            $.mapped_type_clause
          ),
          ']',
          field(
            'type',
            choice($.type_annotation, $.omitting_type_annotation, $.adding_type_annotation, $.opting_type_annotation)
          )
        ),

      array_type: ($) => seq($.primary_type, '[', ']'),
      tuple_type: ($) => seq('[', commaSep($._tuple_type_member), optional(','), ']'),
      readonly_type: ($) => seq('readonly', $.type),

      union_type: ($) =>
        prec.left(
          choice(seq($.type, '|', $.type), prec.dynamic(DYNAMIC_PRECEDENCE.LEADING_TYPE_OPERATOR, seq('|', $.type)))
        ),
      intersection_type: ($) =>
        prec.left(
          choice(seq($.type, '&', $.type), prec.dynamic(DYNAMIC_PRECEDENCE.LEADING_TYPE_OPERATOR, seq('&', $.type)))
        ),

      function_type: ($) =>
        prec.left(
          seq(
            field('type_parameters', optional($.type_parameters)),
            field('parameters', $.formal_parameters),
            '=>',
            field('return_type', choice($.type, $.asserts, $.type_predicate))
          )
        ),

      // A type name may be a reserved word, which TypeScript reports only as a semantic error. The reserved words must be
      // allowed on the identifier inside the alias: around the alias, the keyword token still wins in the lexer.
      _type_identifier: ($) => alias(choice(reserved('properties', $.identifier), 'out'), $.type_identifier),

      _type_reference_identifier: ($) => choice($._type_identifier, alias('in', $.type_identifier)),

      _reserved_identifier: (_, previous) => choice(...TYPESCRIPT_CONTEXTUAL_KEYWORDS, previous),
    },
  });
};

function nestedIdentifierTail($) {
  return [
    '.',
    field(
      'property',
      choice(
        reserved('properties', alias($.identifier, $.property_identifier)),
        alias(choice('in', 'out'), $.property_identifier)
      )
    ),
  ];
}

/**
 * Creates a rule to match one or more of the rules separated by a comma
 *
 * @param {RuleOrLiteral} rule
 *
 * @return {SeqRule}
 *
 */
function commaSep1(rule) {
  return sepBy1(',', rule);
}

/**
 * Creates a rule to optionally match one or more of the rules separated by a comma
 *
 * @param {RuleOrLiteral} rule
 *
 * @return {SeqRule}
 *
 */
function commaSep(rule) {
  return sepBy(',', rule);
}

/**
 * Creates a rule to optionally match one or more of the rules separated by a separator
 *
 * @param {RuleOrLiteral} sep
 *
 * @param {RuleOrLiteral} rule
 *
 * @return {ChoiceRule}
 */
function sepBy(sep, rule) {
  return optional(sepBy1(sep, rule));
}

/**
 * Creates a rule to match one or more of the rules separated by a separator
 *
 * @param {RuleOrLiteral} sep
 *
 * @param {RuleOrLiteral} rule
 *
 * @return {SeqRule}
 */
function sepBy1(sep, rule) {
  return seq(rule, repeat(seq(sep, rule)));
}
