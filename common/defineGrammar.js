// oxlint-disable unicorn/prefer-module -- This package is CommonJS, so tree-sitter loads the grammar as CommonJS.
const JavaScript = require('@willbooster/tree-sitter-javascript/grammar');

module.exports = function defineGrammar(dialect) {
  return grammar(JavaScript, {
    name: dialect,

    externals: ($, previous) => [...previous, $._function_signature_automatic_semicolon, $.__error_recovery],

    supertypes: ($, previous) => [...previous, $.type, $.primary_type],

    precedences: ($, previous) => [
      ...previous,
      ['call', 'instantiation', 'unary', 'binary', $.await_expression, $.arrow_function],
      ['extends', 'instantiation'],
      ['new', 'generic_call', 'instantiation', 'unary', 'binary'],
      [
        $.intersection_type,
        $.union_type,
        $.conditional_type,
        $.function_type,
        'binary',
        $.type_predicate,
        $.readonly_type,
      ],
      [$.mapped_type_clause, $.primary_expression],
      [$.accessibility_modifier, $.primary_expression],
      ['unary_void', $.expression],
      [$.extends_clause, $.primary_expression],
      ['unary', 'assign'],
      ['declaration', $.expression],
      [$.predefined_type, $.unary_expression],
      [$.type, $.flow_maybe_type],
      [$.tuple_type, $.array_type, $.pattern, $.type],
      [$.readonly_type, $.pattern],
      [$.readonly_type, $.primary_expression],
      [$.type_query, $.subscript_expression, $.expression],
      [$.type_query, $._type_query_subscript_expression],
      [$.nested_type_identifier, $.generic_type, $.primary_type, $.lookup_type, $.index_type_query, $.type],
      [$.as_expression, $.satisfies_expression, $.primary_type],
      [$._type_query_member_expression, $.member_expression],
      [$.member_expression, $._type_query_member_expression_in_type_annotation],
      [$._type_query_member_expression, $.primary_expression],
      [$._type_query_subscript_expression, $.subscript_expression],
      [$._type_query_subscript_expression, $.primary_expression],
      [$._type_query_call_expression, $.primary_expression],
      [$._type_query_instantiation_expression, $.primary_expression],
      [$.type_query, $.primary_expression],
      [$.override_modifier, $.primary_expression],
      [$.decorator_call_expression, $.decorator],
      [$.literal_type, $.pattern],
      [$.predefined_type, $.pattern],
      [$.call_expression, $._type_query_call_expression],
      [$.call_expression, $._type_query_call_expression_in_type_annotation],
      [$.new_expression, $.primary_expression],
      [$.meta_property, $.primary_expression],
      [$.construct_signature, $._property_name],
    ],

    conflicts: ($, previous) => [
      ...previous,
      [$.expression, $.call_expression, $.instantiation_expression],
      [$.expression, $.call_expression, $.instantiation_expression, $._extends_clause_single],

      // This appears to be necessary to parse a parenthesized class expression
      [$.class],

      [$.nested_identifier, $.nested_type_identifier, $.primary_expression],
      [$.nested_identifier, $.nested_type_identifier],

      [$._call_signature, $.function_type],
      [$._call_signature, $.constructor_type],

      [$.primary_expression, $._parameter_name],
      [$.primary_expression, $._parameter_name, $.primary_type],
      [$.primary_expression, $.literal_type],
      [$.primary_expression, $.literal_type, $.rest_pattern],
      [$.primary_expression, $.predefined_type, $.rest_pattern],
      [$.primary_expression, $.primary_type],
      [$.primary_expression, $.generic_type],
      [$.primary_expression, $.predefined_type],
      [$.primary_expression, $.pattern, $.primary_type],
      [$._parameter_name, $.primary_type],
      [$.pattern, $.primary_type],

      [$._tuple_label, $.primary_type],
      [$._tuple_label, $.literal_type],
      [$._tuple_label, $.index_type_query],
      [$._tuple_label, $.readonly_type],
      [$._tuple_label, $.predefined_type],
      [$.rest_pattern, $.primary_type, $.primary_expression],

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
            [$.jsx_namespace_name, $.primary_type],
          ]),
    ],

    inline: ($, previous) => [
      ...previous.filter((rule) => !['_formal_parameter', '_call_signature'].includes(rule.name)),
      $._type_identifier,
      $._jsx_start_opening_element,
    ],

    rules: {
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
            seq(optional('static'), optional($.override_modifier), optional('readonly')),
            seq(optional('abstract'), optional('readonly')),
            seq(optional('readonly'), optional('abstract')),
            optional('accessor')
          ),
          field('name', $._property_name),
          optional(choice('?', '!')),
          field('type', optional($.type_annotation)),
          optional($._initializer)
        ),

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
          // could also read the input, as in `a < b > (c)`, TypeScript reads a generic call, hence the dynamic
          // precedence. A tag with type arguments is parsed like a generic call. Optional type arguments in the
          // `template_call` alternative below would make the parser commit to a tagged template at the `<` of `f<T>(x)`.
          prec.dynamic(
            1,
            prec(
              'generic_call',
              seq(
                field('function', choice($.primary_expression, $.new_expression)),
                field('type_arguments', $.type_arguments),
                field('arguments', choice($.arguments, $.template_string))
              )
            )
          ),
          prec(
            'template_call',
            seq(
              field('function', choice($.primary_expression, $.new_expression)),
              field('arguments', $.template_string)
            )
          ),
          prec(
            'member',
            seq(
              field('function', $.primary_expression),
              field('optional_chain', $.optional_chain),
              field('type_arguments', optional($.type_arguments)),
              field('arguments', $.arguments)
            )
          )
        ),

      new_expression: ($) =>
        prec.right(
          'new',
          seq(
            'new',
            field('constructor', $.primary_expression),
            field('type_arguments', optional($.type_arguments)),
            field('arguments', optional($.arguments))
          )
        ),

      assignment_expression: ($) =>
        prec.right(
          'assign',
          seq(field('left', choice($.parenthesized_expression, $._lhs_expression)), '=', field('right', $.expression))
        ),

      _augmented_assignment_lhs: ($, previous) => choice(previous, $.non_null_expression),

      _lhs_expression: ($, previous) => choice(previous, $.non_null_expression),

      primary_expression: ($, previous) => choice(previous, $.non_null_expression),

      // If the dialect is regular typescript, we exclude JSX expressions and
      // include type assertions. If the dialect is TSX, we do the opposite.
      expression: ($, previous) => {
        const choices = [$.as_expression, $.satisfies_expression, $.instantiation_expression, $.internal_module];

        if (dialect === 'typescript') {
          choices.push($.type_assertion);
          choices.push(...previous.members.filter((member) => member.name !== '_jsx_element'));
        } else if (dialect === 'tsx') {
          choices.push(...previous.members);
        } else {
          throw new Error(`Unknown dialect ${dialect}`);
        }

        return choice(...choices);
      },

      _jsx_start_opening_element: ($) =>
        seq(
          '<',
          optional(
            seq(
              choice(
                field('name', choice($._jsx_identifier, $.jsx_namespace_name)),
                seq(
                  field('name', choice($.identifier, alias($.nested_identifier, $.member_expression))),
                  field('type_arguments', optional($.type_arguments))
                )
              ),
              repeat(field('attribute', $._jsx_attribute))
            )
          )
        ),

      // Any identifier name may name a JSX attribute, such as `class` in `<div class="x" />`, which the JavaScript
      // grammar's reserved words reject (WillBooster/tree-sitter-javascript#25).
      _jsx_attribute_name: ($) =>
        choice(
          alias($.jsx_identifier, $.property_identifier),
          alias(reserved('properties', $.identifier), $.property_identifier),
          $.jsx_namespace_name
        ),

      // This rule is only referenced by expression when the dialect is 'tsx'
      jsx_opening_element: ($) => prec.dynamic(-1, seq($._jsx_start_opening_element, '>')),

      // tsx only. See jsx_opening_element.
      jsx_self_closing_element: ($) => prec.dynamic(-1, seq($._jsx_start_opening_element, '/>')),

      export_specifier: (_, previous) => seq(optional(choice('type', 'typeof')), previous),

      // Any identifier name may be exported or imported. The JavaScript grammar rejects reserved words other than
      // `default`, for which it leaves no node (WillBooster/tree-sitter-javascript#17 and #24).
      _module_export_name: ($) => choice(reserved('properties', $.identifier), $.string),

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
          optional($.import_attribute),
          $._semicolon
        ),

      export_statement: ($, previous) =>
        choice(
          previous,
          seq('export', 'type', $.export_clause, optional($._from_clause), $._semicolon),
          seq('export', 'type', choice('*', $.namespace_export), $._from_clause, $._semicolon),
          seq('export', '=', $.expression, $._semicolon),
          seq('export', 'as', 'namespace', $.identifier, $._semicolon)
        ),

      // The JavaScript grammar leaves `await (x).y` ambiguous with a call of an identifier named `await`, and GLR keeps
      // the call; TypeScript and V8 read the operator (WillBooster/tree-sitter-javascript#23).
      await_expression: ($) => prec.dynamic(2, prec('unary_void', seq('await', $.expression))),

      // The JavaScript grammar's for header takes no `using` declaration, although ECMAScript allows one.
      for_statement: ($) =>
        seq(
          'for',
          '(',
          choice(
            field(
              'initializer',
              choice(
                alias($.for_lexical_declaration, $.lexical_declaration),
                alias($.for_variable_declaration, $.variable_declaration),
                alias($._for_using_declaration, $.using_declaration)
              )
            ),
            seq(field('initializer', $._expressions), ';'),
            field('initializer', $.empty_statement)
          ),
          field('condition', choice(seq($._expressions, ';'), $.empty_statement)),
          field('increment', optional($._expressions)),
          ')',
          field('body', $.statement)
        ),

      _for_using_declaration: ($) =>
        seq(field('kind', choice('using', seq('await', 'using'))), commaSep1($.variable_declarator), ';'),

      non_null_expression: ($) => prec.left('unary', seq($.expression, '!')),

      variable_declarator: ($) =>
        choice(
          seq(
            field('name', choice($.identifier, alias('of', $.identifier), $._destructuring_pattern)),
            field('type', optional($.type_annotation)),
            optional($._initializer)
          ),
          prec('declaration', seq(field('name', $.identifier), '!', field('type', $.type_annotation)))
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
            field('function', choice($.identifier, alias($.decorator_member_expression, $.member_expression))),
            optional(field('type_arguments', $.type_arguments)),
            field('arguments', $.arguments)
          )
        ),

      decorator_parenthesized_expression: ($) => seq('(', $._expressions, ')'),

      // A decorator's member name may be any identifier name, as a member expression's may, which the JavaScript
      // grammar's reserved words reject.
      decorator_member_expression: ($) =>
        prec(
          'member',
          seq(
            field('object', choice($.identifier, alias($.decorator_member_expression, $.member_expression))),
            '.',
            field('property', reserved('properties', alias($.identifier, $.property_identifier)))
          )
        ),

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
            field('body', $.statement_block)
          )
        ),

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

      instantiation_expression: ($) =>
        prec.dynamic(
          -1,
          prec(
            'instantiation',
            seq(choice($.primary_expression, $.new_expression), field('type_arguments', $.type_arguments))
          )
        ),

      class_heritage: ($) => choice(seq($.extends_clause, optional($.implements_clause)), $.implements_clause),

      import_require_clause: ($) => seq($.identifier, '=', 'require', '(', field('source', $.string), ')'),

      extends_clause: ($) => seq('extends', commaSep1($._extends_clause_single)),

      _extends_clause_single: ($) =>
        prec(
          'extends',
          choice(
            field('value', $.expression),
            seq(field('value', $.primary_expression), field('type_arguments', $.type_arguments))
          )
        ),

      implements_clause: ($) => seq('implements', commaSep1($.type)),

      ambient_declaration: ($) =>
        seq(
          'declare',
          choice(
            $.declaration,
            seq('global', $.statement_block),
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

      _module: ($) =>
        prec.right(
          seq(
            field('name', choice($.string, reserved('properties', $.identifier), $.nested_identifier)),
            // On .d.ts files "declare module foo" desugars to "declare module foo {}",
            // hence why it is optional here
            field('body', optional($.statement_block))
          )
        ),

      import_alias: ($) => seq('import', $.identifier, '=', choice($.identifier, $.nested_identifier), $._semicolon),

      // A qualified name may end in any identifier name, as a member expression may.
      nested_identifier: ($) =>
        prec(
          'member',
          seq(
            field('object', choice($.identifier, alias($.nested_identifier, $.member_expression))),
            '.',
            field('property', reserved('properties', alias($.identifier, $.property_identifier)))
          )
        ),

      nested_type_identifier: ($) =>
        prec(
          'member',
          seq(field('module', choice($.identifier, $.nested_identifier)), '.', field('name', $._type_identifier))
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

      asserts: ($) => seq('asserts', choice($.type_predicate, $.identifier, $.this)),

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

      _tuple_rest_label: ($) => seq('...', $._tuple_label),

      // TypeScript accepts any identifier name as a tuple label, but where a tuple member begins, the keywords that
      // can begin a type are lexed as those keywords, so they are listed here. Keywords that are rules of their own
      // are aliased as rules: repeating their strings would turn those rules into nodes that wrap a token.
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
          $._type_identifier,
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
                $._type_identifier,
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
          optional('const'),
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

      // TypeScript allows a leading `|` or `&` only at the start of a type, so `a < b || c > (d)` compares instead of
      // calling `a` with `b | | c`. The negative dynamic precedence outweighs that of the generic call.
      union_type: ($) => prec.left(choice(seq($.type, '|', $.type), prec.dynamic(-2, seq('|', $.type)))),
      intersection_type: ($) => prec.left(choice(seq($.type, '&', $.type), prec.dynamic(-2, seq('&', $.type)))),

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
      _type_identifier: ($) => alias(reserved('properties', $.identifier), $.type_identifier),

      _reserved_identifier: (_, previous) =>
        choice(
          'declare',
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
          'export',
          'object',
          'new',
          'readonly',
          previous
        ),
    },
  });
};

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
