import fs from 'node:fs';
import path from 'node:path';

import { type Language, Query } from '@willbooster/web-tree-sitter';

import treeSitterJson from '../../tree-sitter.json';

export function configuredQueries(language: Language, dialect: string): Query[] {
  const queries: Query[] = [];
  try {
    const grammar = treeSitterJson.grammars.find((entry) => entry.name === dialect)!;
    for (const files of [grammar.highlights, grammar.tags, grammar.locals, grammar.injections]) {
      const querySource = [files]
        .flat()
        .map((file) => fs.readFileSync(path.join(import.meta.dirname, '../..', file), 'utf8'))
        .join('\n');
      queries.push(new Query(language, querySource));
    }
    return queries;
  } catch (error) {
    for (const query of queries) query.delete();
    throw error;
  }
}
