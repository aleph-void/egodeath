/**
 * Rewrite `export <declaration>` into `<declaration>; export { name, … }`.
 *
 * Identifier renaming renames every top-level binding, including the ones an
 * `export const c` / `export function f` / `export class K` declares. The
 * binding name doubles as the module's public export name there, so renaming
 * it silently changed the module's API (`import { c }` stopped resolving).
 *
 * Splitting the declaration from the export separates the two names: the
 * binding is renamed like any other, and the `export { c }` specifier keeps
 * `c` as the public name (secondPass renames only the specifier's `local`).
 * Function declarations keep their hoisting; `let`/`const`/`class` keep
 * their TDZ, since the export list is evaluated with the module, not in
 * statement order.
 *
 * `export default <decl>` is left alone: its public name is `default`
 * regardless of the binding name.
 */

/** Collect binding identifiers from a declaration pattern. */
function patternNames(node: any, out: string[]): void {
  if (!node) return;
  switch (node.type) {
    case 'Identifier':
      out.push(node.name);
      break;
    case 'ObjectPattern':
      for (const p of node.properties) {
        if (p.type === 'RestElement') patternNames(p.argument, out);
        else patternNames(p.value, out);
      }
      break;
    case 'ArrayPattern':
      for (const el of node.elements) patternNames(el, out);
      break;
    case 'RestElement':
      patternNames(node.argument, out);
      break;
    case 'AssignmentPattern':
      patternNames(node.left, out);
      break;
  }
}

function exportedNames(decl: any): string[] {
  const names: string[] = [];
  if (decl.type === 'VariableDeclaration') {
    for (const d of decl.declarations) patternNames(d.id, names);
  } else if (
    (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') &&
    decl.id && decl.id.type === 'Identifier'
  ) {
    names.push(decl.id.name);
  }
  return names;
}

export function splitExportDeclarations(program: any): void {
  if (!program || !Array.isArray(program.body)) return;
  const body: any[] = [];
  for (const stmt of program.body) {
    if (stmt.type !== 'ExportNamedDeclaration' || !stmt.declaration) {
      body.push(stmt);
      continue;
    }
    const decl = stmt.declaration;
    const names = exportedNames(decl);
    // TypeScript-only declarations (`export type`, `export interface`, …)
    // or anything we can't name: keep the original statement.
    if (names.length === 0) {
      body.push(stmt);
      continue;
    }
    // Comments attached to `export …` (JSDoc etc.) belong to the declaration.
    if (stmt.comments && !decl.comments) decl.comments = stmt.comments;
    body.push(decl);
    body.push({
      type: 'ExportNamedDeclaration',
      declaration: null,
      source: null,
      specifiers: names.map((name) => ({
        type: 'ExportSpecifier',
        local: { type: 'Identifier', name },
        exported: { type: 'Identifier', name },
      })),
    });
  }
  program.body = body;
}
