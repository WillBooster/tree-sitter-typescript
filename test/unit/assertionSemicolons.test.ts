import { type Node, Parser, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { loadCurrentWasmBuild } from './wasmBuild.js';

const Header = 'declare const value: any;\ntype T = any;\ntype U = any;\n';
const Footer = '\nconst following = 1;';
const LineBreaks = ['\n', '\r', '\r\n', '\u2028', '\u2029', '/*\n*/', '// comment\n'];
const Expressions = ['value as T', 'value satisfies T', '(value as T)', '(value satisfies T)'];
const FollowingExpressions = ['(value);', '[0];', '`text`;'];
const AdditionalSources = [
  'value as T | U\n(value);',
  'value as ((x: any) => any)\n(value);',
  'value as T\n+ value;',
  'value as T\n- value;',
  'value satisfies T\n&& value;',
  'function f() { return value as T\n(value); }',
  'function f() { return value satisfies T\n[0]; }',
  'const arrow = () => value as T\n(value);',
  'const arrow = async () => value satisfies T\n`text`;',
];

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves compiler statement boundaries after ${dialect} assertions`, async () => {
    await Parser.init();
    const parser = new Parser().setLanguage(await loadCurrentWasmBuild(dialect));
    const sources = Expressions.flatMap((expression) =>
      FollowingExpressions.flatMap((following) => LineBreaks.map((gap) => expression + gap + following))
    );
    try {
      for (const body of [...sources, ...AdditionalSources]) {
        const source = Header + body + Footer;
        const tree = parser.parse(source)!;
        try {
          checkStatements(tree, source, dialect);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });
}

function checkStatements(tree: Tree, source: string, dialect: string): void {
  const fileName = dialect === 'tsx' ? 'fixture.tsx' : 'fixture.ts';
  const reference = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  expect(
    ts
      .transpileModule(source, {
        fileName,
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.Preserve },
      })
      .diagnostics?.map((diagnostic) => diagnostic.code) ?? [],
    source
  ).toEqual([]);
  expect(tree.rootNode.hasError, source).toBe(false);
  const expected = (statements: ts.NodeArray<ts.Statement>): number[][] =>
    statements.map((statement) => [statement.getStart(reference), statement.end]);
  expect(statementContentRanges(tree.rootNode), source).toEqual(expected(reference.statements));
  checkComments(tree, source);
  const blocks: ts.Block[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isBlock(node)) blocks.push(node);
    ts.forEachChild(node, visit);
  };
  visit(reference);
  const parsedBlocks = tree.rootNode.descendantsOfType('statement_block');
  expect(parsedBlocks, source).toHaveLength(blocks.length);
  for (const block of blocks) {
    const parsed = parsedBlocks.find(
      (node) => node.startIndex === block.getStart(reference) && node.endIndex === block.end
    );
    expect(parsed, source).toBeDefined();
    expect(statementContentRanges(parsed!), source).toEqual(expected(block.statements));
  }
}

function statementContentRanges(node: Node): number[][] {
  return node.namedChildren
    .filter((child) => !child.isExtra)
    .map((child) => {
      const content = child.children.filter((part) => !part.isExtra);
      return [content[0]?.startIndex ?? child.startIndex, content.at(-1)?.endIndex ?? child.endIndex];
    });
}

function checkComments(tree: Tree, source: string): void {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  const comments: (number | string)[][] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      comments.push([scanner.getTokenPos(), scanner.getTextPos(), scanner.getTokenText()]);
    }
  }
  expect(
    tree.rootNode.descendantsOfType('comment').map((node) => [node.startIndex, node.endIndex, node.text]),
    source
  ).toEqual(comments);
}
