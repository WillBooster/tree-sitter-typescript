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
}
interface Starts {
  words: Set<string>;
  nullable: boolean;
}

export function queryOperandKeywords({ rules }: Grammar): string[] {
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
  const allowed = new Set([
    ...starts.get('_type_query_identifier')!.words,
    ...starts.get('this')!.words,
    ...starts.get('import')!.words,
  ]);
  return [...starts.get('expression')!.words].filter((word) => !allowed.has(word)).toSorted();
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
