import { IdentifierNode, LiteralNode } from './types';

/**
 * Create an AST Identifier node.
 */
export function Identifier(name: string): IdentifierNode {
  return { type: 'Identifier', name };
}

/**
 * Create an AST Literal node.
 */
export function Literal(value: any): LiteralNode {
  return { type: 'Literal', value };
}

/**
 * Node types whose `key` is a property name: a string or numeric literal in
 * that slot is a *name*, not a value, and may only be replaced by an
 * expression when the member is `computed` (`{ [expr]() {} }`). Covers both
 * Babel and ESTree shapes, plus TypeScript members.
 */
const KEYED_MEMBER_TYPES = new Set([
  'Property', 'ObjectProperty', 'ObjectMethod',
  'ClassMethod', 'ClassPrivateMethod', 'ClassProperty', 'ClassAccessorProperty',
  'MethodDefinition', 'PropertyDefinition', 'AccessorProperty',
  'TSPropertySignature', 'TSMethodSignature', 'TSDeclareMethod',
]);

/**
 * True when `node` sits in a position where the grammar requires a literal
 * name, so a transform must not swap it for an arbitrary expression:
 * a non-computed member key (`get "x"() {}`, `{ 3: v }`, `class { "y" = 1 }`)
 * or a string module-export name (`export { a as "b" }`,
 * `import { "c" as d }`) or an import attribute (`with { type: "json" }`).
 */
export function isLiteralNamePosition(node: any, parent: any): boolean {
  if (!parent) return false;
  if (KEYED_MEMBER_TYPES.has(parent.type)) {
    return parent.key === node && !parent.computed;
  }
  switch (parent.type) {
    case 'ImportSpecifier':
      return parent.imported === node;
    case 'ExportSpecifier':
      return parent.exported === node || parent.local === node;
    case 'ExportNamespaceSpecifier':
      return parent.exported === node;
    case 'ImportAttribute':
      return parent.key === node || parent.value === node;
    default:
      return false;
  }
}
