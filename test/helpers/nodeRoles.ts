import { type Node } from '@willbooster/web-tree-sitter';

export function walkNodes(node: Node, visit: (current: Node) => void): void {
  visit(node);
  for (const child of node.children) walkNodes(child, visit);
}

export function parameterBindingRanges(root: Node, name?: string, includeOptional = true): [string, number, number][] {
  return parameterBindingIdentifiers(root, includeOptional)
    .filter((node) => name === undefined || node.text === name)
    .map((node) => [node.text, node.startIndex, node.endIndex]);
}

export function parameterBindingIdentifiers(root: Node, includeOptional = true): Node[] {
  const types = includeOptional ? ['required_parameter', 'optional_parameter'] : 'required_parameter';
  return root.descendantsOfType(types).flatMap((node) => {
    const pattern = node.childForFieldName('pattern');
    return pattern?.type === 'identifier' ? [pattern] : [];
  });
}

export function typeAliasRoles(root: Node): ['name' | 'value', string, string, number, number][] {
  return root.descendantsOfType('type_alias_declaration').flatMap((node) => {
    const name = node.childForFieldName('name');
    const value = node.childForFieldName('value');
    return name?.type === 'type_identifier' && value
      ? [
          ['name', name.type, name.text, name.startIndex, name.endIndex],
          ['value', value.type, value.text, value.startIndex, value.endIndex],
        ]
      : [];
  });
}

export function tupleLabelIdentifiers(root: Node): Node[] {
  return root.descendantsOfType('tuple_type').flatMap((tuple) =>
    tuple.namedChildren.flatMap((param) => {
      if (param.type !== 'required_parameter' && param.type !== 'optional_parameter') return [];
      const label = param.childForFieldName('name');
      if (!label) return [];
      const leaf = label.type === 'rest_pattern' ? firstNonExtraNamedChild(label) : label;
      return leaf?.type === 'identifier' ? [leaf] : [];
    })
  );
}

export function jsxTagNameNodes(root: Node): Node[] {
  return root
    .descendantsOfType(['jsx_opening_element', 'jsx_closing_element', 'jsx_self_closing_element'])
    .flatMap((element) => {
      const name = element.childForFieldName('name');
      return name ? [name] : [];
    });
}

export function nonExtraNamedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child) => !child.isExtra);
}

export function firstNonExtraNamedChild(node: Node): Node | undefined {
  return node.namedChildren.find((child) => !child.isExtra);
}
