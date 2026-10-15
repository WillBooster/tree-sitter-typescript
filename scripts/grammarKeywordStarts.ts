import assert from 'node:assert/strict';

interface Rule {
  type: string;
  name?: string;
  value?: string | number;
  named?: boolean;
  content?: Rule;
  members?: Rule[];
}
interface Grammar {
  rules: Record<string, Rule>;
  reserved: Record<string, Rule[]>;
}
interface Starts {
  words: Set<string>;
  nullable: boolean;
}

interface OperandKeywords {
  query: string[];
  expressionOnly: string[];
  assertion: string[];
  assertionPredicate: string[];
  parameterHeader: string[];
  expressionPrefix: string[];
  nonParameterPattern: string[];
  typeOnlyAtom: string[];
}

export function grammarOperandKeywords(grammar: Grammar): OperandKeywords {
  const { rules } = grammar;
  const aliases = new Map<string, string>();
  for (const rule of Object.values(rules)) collectExternalAliases(rule, aliases);
  const starts = new Map(Object.keys(rules).map((name) => [name, { words: new Set<string>(), nullable: false }]));
  let changed: boolean;
  do {
    changed = false;
    for (const [name, rule] of Object.entries(rules)) {
      const next = ruleStarts(rule, starts, aliases);
      const previous = starts.get(name)!;
      if (next.nullable !== previous.nullable || next.words.size !== previous.words.size) changed = true;
      starts.set(name, next);
    }
  } while (changed);
  return classifyOperandKeywords(grammar, starts, aliases);
}

function classifyOperandKeywords(
  { rules, reserved }: Grammar,
  starts: Map<string, Starts>,
  aliases: Map<string, string>
): OperandKeywords {
  const allowedQuery = new Set([
    ...starts.get('_type_query_identifier')!.words,
    ...starts.get('this')!.words,
    ...starts.get('import')!.words,
  ]);
  const reservedWords = new Set(reserved.global!.flatMap((rule) => [...ruleStarts(rule, starts, aliases).words]));
  const type = starts.get('type')!.words;
  const expression = starts.get('expression')!.words;
  const expressionOperators = new Set(expression);
  collectWordTokens(rules.binary_expression!, expressionOperators);
  const assertion = rules.asserts!;
  assert.equal(assertion.type, 'SEQ');
  assert.equal(assertion.members![0]!.value, 'asserts');
  const assertionNames = ruleStarts(assertion.members![1]!, starts, aliases).words;
  assert.equal(assertion.members![1]!.type, 'CHOICE');
  const standaloneAssertion = ruleStarts(
    {
      type: 'CHOICE',
      members: assertion.members![1]!.members!.filter(
        (rule) => rule.type !== 'SYMBOL' || rule.name !== 'type_predicate'
      ),
    },
    starts,
    aliases
  ).words;
  const contextualUnaryWords = new Set(
    [...starts.get('await_expression')!.words].filter((word) => !reservedWords.has(word))
  );
  const expressionOnly = [...expressionOperators]
    .filter((word) => !type.has(word) && !contextualUnaryWords.has(word))
    .toSorted();
  const parameterNames = starts.get('_reserved_identifier')!.words;
  const parameterThis = starts.get('this')!.words;
  const expressionPrefix = new Set(
    [
      'unary_expression',
      'await_expression',
      'yield_expression',
      'new_expression',
      'function_expression',
      'generator_function',
      'class',
    ].flatMap((name) => [...starts.get(name)!.words])
  );
  return {
    typeOnlyAtom: [...starts.get('predefined_type')!.words].filter((word) => !parameterNames.has(word)).toSorted(),
    expressionPrefix: [...expressionPrefix].toSorted(),
    nonParameterPattern: [...expression]
      .filter(
        (word) => !parameterNames.has(word) && !parameterThis.has(word) && !starts.get('_identifier')!.words.has(word)
      )
      .toSorted(),
    parameterHeader: [...starts.get('_reserved_identifier')!.words]
      .filter((word) => expressionOnly.includes(word))
      .toSorted(),
    assertionPredicate: [...assertionNames].filter((word) => !standaloneAssertion.has(word)).toSorted(),
    query: [...expression].filter((word) => !allowedQuery.has(word)).toSorted(),
    expressionOnly,
    assertion: [...reservedWords].filter((word) => !assertionNames.has(word)).toSorted(),
  };
}

function collectWordTokens(rule: Rule, words: Set<string>): void {
  if ((rule.type === 'STRING' || (rule.type === 'ALIAS' && !rule.named)) && isWord(rule.value)) words.add(rule.value);
  if (rule.content) collectWordTokens(rule.content, words);
  for (const member of rule.members ?? []) collectWordTokens(member, words);
}

function collectExternalAliases(rule: Rule, aliases: Map<string, string>): void {
  if (rule.type === 'ALIAS' && !rule.named && rule.content?.type === 'SYMBOL' && isWord(rule.value)) {
    const name = rule.content.name!;
    assert.ok(!aliases.has(name) || aliases.get(name) === rule.value, `Conflicting keyword aliases for ${name}`);
    aliases.set(name, rule.value);
  }
  if (rule.content) collectExternalAliases(rule.content, aliases);
  for (const member of rule.members ?? []) collectExternalAliases(member, aliases);
}

function ruleStarts(rule: Rule, starts: Map<string, Starts>, aliases: Map<string, string>): Starts {
  if (rule.type === 'STRING' || (rule.type === 'ALIAS' && !rule.named)) {
    return { words: new Set(isWord(rule.value) ? [rule.value] : []), nullable: rule.value === '' };
  }
  if (rule.type === 'SYMBOL') {
    const alias = aliases.get(rule.name!);
    return starts.get(rule.name!) ?? { words: new Set(alias ? [alias] : []), nullable: false };
  }
  if (rule.type === 'BLANK' || rule.type === 'PATTERN') {
    return { words: new Set(), nullable: rule.type === 'BLANK' };
  }
  if (rule.type === 'CHOICE' || rule.type === 'SEQ') return memberStarts(rule, starts, aliases);
  assert.ok(rule.content, `Unsupported grammar rule ${rule.type}`);
  const next = ruleStarts(rule.content, starts, aliases);
  return { words: next.words, nullable: rule.type === 'REPEAT' || next.nullable };
}

function memberStarts(rule: Rule, starts: Map<string, Starts>, aliases: Map<string, string>): Starts {
  const words = new Set<string>();
  let nullable = rule.type === 'SEQ';
  for (const member of rule.members!) {
    const next = ruleStarts(member, starts, aliases);
    for (const word of next.words) words.add(word);
    if (rule.type === 'SEQ' && !next.nullable) return { words, nullable: false };
    if (rule.type === 'CHOICE' && next.nullable) nullable = true;
  }
  return { words, nullable };
}

function isWord(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z]+$/.test(value);
}
