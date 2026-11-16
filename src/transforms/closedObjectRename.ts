import { VISITOR_KEYS as EXTRA_VISITOR_KEYS } from '../visitorKeys';
import * as estraverse from 'estraverse';
import { gen } from '../random';
import { ScopeAnalysis } from '../scopeAnalysis';

/**
 * Closed-object literal key rename.
 *
 * For a binding of the form `const obj = { a: ..., b: ... }` where every
 * reference to `obj` outside the declaration is of the form `obj.X`
 * (read, write, call, update, optional chain — all non-computed
 * MemberExpressions), the object cannot be observed from the outside:
 * nothing iterates its keys, nothing serializes it, nothing passes it
 * around. That means the property names are an internal convention,
 * and we can replace every key (and every access) with a fresh random
 * Unicode identifier with no runtime effect.
 *
 * Payoff: what were meaningful names in the source (`apiKey`,
 * `ROLE_ADMIN`, `retryCount`) come out as opaque gen()-style renders,
 * both in the object literal AND in the stringArray pool that
 * propertyKeyEncoding feeds into — so key-name searches across the
 * final output find nothing.
 *
 * Preconditions the analyzer enforces before renaming:
 *   - Declaration is a VariableDeclarator with a simple Identifier id
 *     and an ObjectExpression initializer.
 *   - Every property of the object literal is an ObjectProperty with a
 *     non-computed simple key (Identifier or StringLiteral of a string
 *     value) — no SpreadElement, no ObjectMethod, no computed keys.
 *   - No property value contains a FunctionExpression or ObjectMethod;
 *     those carry their own `this` binding, so renaming `obj.a` would
 *     silently also need to rename `this.a` inside the method body,
 *     and analyzing that is deferred. ArrowFunctionExpression values
 *     are fine (arrows have no own `this`) — any `obj`-by-closure
 *     reference inside an arrow goes through the normal escape check.
 *   - Every method-style call through the binding (`obj.f()`,
 *     `obj?.f()`, `(obj.f)()`, `` obj.f`…` ``) runs with `this === obj`,
 *     so `this.X` inside the callee would still read the old key. Such a
 *     call is accepted only when `f` is provably `this`-free: the
 *     declaration defines `f` and nothing else ever writes `obj.f`, and
 *     its value is a primitive literal, an arrow function, or an
 *     identifier bound exactly once (never reassigned) to an arrow
 *     function or to a function whose body never uses `this`, `super` or
 *     direct `eval`. Any other value — a member expression such as
 *     `hi: obj.hi`, a call result, a parameter — could be a function
 *     defined elsewhere that reads `this.X`, so the candidate is dropped.
 *   - Every reference to the binding is the `.object` of a non-computed
 *     MemberExpression / OptionalMemberExpression. Anything else —
 *     return statement, call argument, aliasing assignment, spread,
 *     truthiness check, reassignment, etc. — disqualifies the
 *     candidate.
 *   - No accessed property name (declaration side or access side) is
 *     on the SKIP_PROPS list below.
 *
 * Runs before firstPass so the renamed keys are absorbed by the
 * normal identifier machinery: non-computed property positions stay
 * skipped by secondPass, and propertyKeyEncoding / stringArrayExtraction
 * pick up the Unicode renders when they do their usual post-pass work.
 */

/**
 * Property names we refuse to rename even when the binding is
 * formally closed. These are Object.prototype members or names that
 * duck-typed APIs inspect (thenables, iterables) — renaming them
 * produces silent behavior changes: suddenly `obj.toString()` returns
 * Object.prototype.toString instead of the user's, or `await obj`
 * stops seeing the `then` handler.
 */
const SKIP_PROPS = new Set<string>([
  'constructor', 'prototype', '__proto__',
  'hasOwnProperty', 'toString', 'valueOf', 'propertyIsEnumerable',
  'isPrototypeOf', 'toLocaleString',
  'length', 'name',
  'then', 'catch', 'finally',
]);

type AccessKind = 'read' | 'write' | 'call';

interface Candidate {
  declarator: any;    // VariableDeclarator whose .init is the object literal
  objExpr: any;       // the ObjectExpression
  accesses: Array<{ memberNode: any; propName: string; kind: AccessKind }>;
  safe: boolean;
}

/** What we know about a binding when an object property value names it. */
interface BindingInfo {
  decls: Array<{ node: any; kind: string }>; // FunctionDeclaration or VariableDeclarator (+ var/let/const)
  written: boolean;   // reassigned, or bound by some other form (param, catch, import, class, pattern)
}

/** Nearest ancestor that is not a ParenthesizedExpression, with the child it was reached from. */
function effectiveParent(node: any, ancestors: any[]): { parent: any; child: any; index: number } {
  let child = node;
  let i = ancestors.length - 1;
  while (i >= 0 && ancestors[i].type === 'ParenthesizedExpression') {
    child = ancestors[i];
    i--;
  }
  return { parent: i >= 0 ? ancestors[i] : null, child, index: i };
}

/**
 * True when `node` (an Identifier or MemberExpression) sits in a position
 * that assigns to it: assignment/update target, `delete` operand,
 * for-in/of head, or any destructuring-pattern slot.
 */
function isWritePosition(node: any, ancestors: any[]): boolean {
  const { parent, child, index } = effectiveParent(node, ancestors);
  if (!parent) return false;
  switch (parent.type) {
    case 'AssignmentExpression':
    case 'AssignmentPattern':
      return parent.left === child;
    case 'UpdateExpression':
      return true;
    case 'UnaryExpression':
      return parent.operator === 'delete';
    case 'ForInStatement':
    case 'ForOfStatement':
      return parent.left === child;
    case 'ArrayPattern':
    case 'RestElement':
      return true;
    case 'ObjectProperty':
    case 'Property': {
      const gp = index > 0 ? ancestors[index - 1] : null;
      return !!gp && gp.type === 'ObjectPattern' && parent.value === child;
    }
    default:
      return false;
  }
}

/** True when `member` is invoked as a method, so the callee runs with `this` = its object. */
function isMethodCallPosition(member: any, ancestors: any[]): boolean {
  const { parent, child } = effectiveParent(member, ancestors);
  if (!parent) return false;
  if (parent.type === 'CallExpression' || parent.type === 'OptionalCallExpression') {
    return parent.callee === child;
  }
  if (parent.type === 'TaggedTemplateExpression') return parent.tag === child;
  return false;
}

/**
 * True when a function body (params included) can never observe its
 * `this`: no ThisExpression or Super outside nested `function`s (which
 * rebind `this`), and no direct `eval(…)` that could read it.
 * Conservative: object/class methods are not treated as boundaries.
 */
function isThisFreeFunction(fn: any): boolean {
  let clean = true;
  const visit = (root: any) => estraverse.traverse(root, {
    keys: EXTRA_VISITOR_KEYS,
    enter(n: any): any {
      if (n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration') {
        return (estraverse as any).VisitorOption.Skip;
      }
      if (
        n.type === 'ThisExpression' || n.type === 'Super' ||
        (n.type === 'CallExpression' && n.callee && n.callee.type === 'Identifier' && n.callee.name === 'eval')
      ) {
        clean = false;
        return (estraverse as any).VisitorOption.Break;
      }
    },
    fallback: 'iteration',
  } as any);
  for (const p of fn.params || []) if (clean) visit(p);
  if (clean && fn.body) visit(fn.body);
  return clean;
}

const PRIMITIVE_LITERALS = new Set([
  'StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral', 'BigIntLiteral', 'Literal',
]);

/**
 * True when calling the value as `obj.key()` provably cannot read `obj`
 * through `this` (calling a primitive just throws).
 */
function isThisFreeCallee(value: any, analysis: ScopeAnalysis, bindings: Map<string, BindingInfo>): boolean {
  if (!value) return false;
  if (PRIMITIVE_LITERALS.has(value.type)) return true;
  if (value.type === 'ArrowFunctionExpression') return true;
  if (value.type !== 'Identifier') return false;
  const render = analysis.resolvedNames.get(value);
  if (!render) return false; // global / unresolved: could be anything
  const info = bindings.get(render);
  if (!info || info.written || info.decls.length !== 1) return false;
  const { node, kind } = info.decls[0];
  if (node.type === 'FunctionDeclaration') return isThisFreeFunction(node);
  if (node.type === 'VariableDeclarator' && kind === 'const' && node.init) {
    if (node.init.type === 'ArrowFunctionExpression') return true;
    if (node.init.type === 'FunctionExpression') return isThisFreeFunction(node.init);
  }
  return false;
}

/**
 * Map every resolved binding to its declarations, and flag bindings that
 * are ever written or bound by a form we don't model.
 */
function collectBindings(ast: any, analysis: ScopeAnalysis): Map<string, BindingInfo> {
  const bindings = new Map<string, BindingInfo>();
  const get = (render: string) => {
    let info = bindings.get(render);
    if (!info) { info = { decls: [], written: false }; bindings.set(render, info); }
    return info;
  };
  estraverse.traverse(ast.program, {
    keys: EXTRA_VISITOR_KEYS,
    enter(this: any, node: any, parent: any) {
      if (node.type !== 'Identifier') return;
      const render = analysis.resolvedNames.get(node);
      if (!render) return;
      if (!parent) return;
      if (parent.type === 'FunctionDeclaration' && parent.id === node) {
        get(render).decls.push({ node: parent, kind: 'function' });
        return;
      }
      if (parent.type === 'VariableDeclarator' && parent.id === node) {
        const ancestors = this.parents();
        const declaration = ancestors[ancestors.length - 2];
        get(render).decls.push({ node: parent, kind: declaration ? declaration.kind : 'var' });
        return;
      }
      const isParam =
        (parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' ||
         parent.type === 'ArrowFunctionExpression' || parent.type === 'ObjectMethod' ||
         parent.type === 'ClassMethod' || parent.type === 'ClassPrivateMethod') &&
        (parent.params || []).includes(node);
      const otherBinding =
        isParam ||
        (parent.type === 'FunctionExpression' && parent.id === node) ||
        (parent.type === 'CatchClause' && parent.param === node) ||
        ((parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression') && parent.id === node) ||
        /^Import.*Specifier$/.test(parent.type);
      if (otherBinding || isWritePosition(node, this.parents())) get(render).written = true;
    },
    fallback: 'iteration',
  } as any);
  return bindings;
}

/**
 * Return true if the subtree contains a FunctionExpression or
 * ObjectMethod — i.e. a function form that carries its own `this`.
 * ArrowFunctionExpression is NOT a hit: arrows have no own `this`, so
 * any `this` inside an arrow resolves to the enclosing scope, not to
 * the object being defined.
 */
function containsOwnThisFunction(root: any): boolean {
  let found = false;
  estraverse.traverse(root, {
    keys: EXTRA_VISITOR_KEYS,
    enter(n: any): any {
      if (n.type === 'FunctionExpression' || n.type === 'ObjectMethod') {
        found = true;
        return (estraverse as any).VisitorOption.Break;
      }
    },
    fallback: 'iteration',
  } as any);
  return found;
}

/** Extract the property key as a string when it's a simple non-computed key; otherwise null. */
function extractKeyName(prop: any): string | null {
  if (!prop || prop.computed) return null;
  if (!prop.key) return null;
  if (prop.key.type === 'Identifier') return prop.key.name || null;
  if (prop.key.type === 'StringLiteral') {
    return typeof prop.key.value === 'string' ? prop.key.value : null;
  }
  // ESTree Literal (espree/acorn shape); babel uses StringLiteral.
  if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') return prop.key.value;
  return null;
}

/** Disqualify an ObjectExpression for rename; return its set of key names if accepted. */
function collectDeclarationKeys(objExpr: any): Set<string> | null {
  const keys = new Set<string>();
  const props = objExpr.properties || [];
  for (const p of props) {
    if (!p) continue;
    if (p.type === 'SpreadElement') return null;
    if (p.type === 'ObjectMethod') return null;
    if (p.type !== 'ObjectProperty' && p.type !== 'Property') return null;
    const name = extractKeyName(p);
    if (name === null) return null;
    if (SKIP_PROPS.has(name)) return null;
    if (p.value && containsOwnThisFunction(p.value)) return null;
    keys.add(name);
  }
  return keys;
}

/**
 * Run the closed-object rename pass over the program. Returns the
 * number of bindings whose keys were renamed (useful for tests and
 * debug output; the obfuscator itself ignores the return value).
 */
export function applyClosedObjectRename(ast: any, analysis: ScopeAnalysis): number {
  const candidates = new Map<string, Candidate>();

  // Step 1: collect declarations that look eligible on their face.
  estraverse.traverse(ast.program, {
    keys: EXTRA_VISITOR_KEYS,
    enter(node: any) {
      if (node.type !== 'VariableDeclarator') return;
      if (!node.id || node.id.type !== 'Identifier') return;
      if (!node.init || node.init.type !== 'ObjectExpression') return;
      const render = analysis.resolvedNames.get(node.id);
      if (!render) return; // unresolved bindings (keyword names) never make it into our map

      // Duplicate VariableDeclarators for the same binding (var hoisting
      // with re-declaration) defeat the "we know the full shape" claim.
      if (candidates.has(render)) {
        candidates.get(render)!.safe = false;
        return;
      }
      const keys = collectDeclarationKeys(node.init);
      if (!keys) return;
      candidates.set(render, {
        declarator: node,
        objExpr: node.init,
        accesses: [],
        safe: true,
      });
    },
    fallback: 'iteration',
  } as any);

  if (candidates.size === 0) return 0;

  // Step 2: examine every reference. Any non-`obj.X` context disqualifies.
  estraverse.traverse(ast.program, {
    keys: EXTRA_VISITOR_KEYS,
    enter(this: any, node: any, parent: any) {
      if (node.type !== 'Identifier') return;
      const render = analysis.resolvedNames.get(node);
      if (!render) return;
      const cand = candidates.get(render);
      if (!cand) return;
      if (node === cand.declarator.id) return; // the declaration itself

      const isMember =
        parent &&
        (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression');
      if (
        isMember &&
        parent.object === node &&
        !parent.computed &&
        parent.property &&
        parent.property.type === 'Identifier'
      ) {
        const pname = parent.property.name;
        if (SKIP_PROPS.has(pname)) {
          cand.safe = false;
          return;
        }
        // this.parents() ends with `parent`; drop it to get the member's ancestors.
        const memberAncestors = this.parents().slice(0, -1);
        const kind: AccessKind = isMethodCallPosition(parent, memberAncestors)
          ? 'call'
          : isWritePosition(parent, memberAncestors) ? 'write' : 'read';
        cand.accesses.push({ memberNode: parent, propName: pname, kind });
        return;
      }

      // Any other parent context: call argument, return, assignment
      // target, spread source, truthiness check, etc. Conservatively
      // treat as an escape.
      cand.safe = false;
    },
    fallback: 'iteration',
  } as any);

  // Step 3: method calls through the binding run the callee with
  // `this === obj`. Renaming is only sound when every such callee is
  // provably `this`-free (see the header comment).
  let bindings: Map<string, BindingInfo> | null = null;
  for (const cand of candidates.values()) {
    if (!cand.safe) continue;
    const called = new Set<string>();
    const written = new Set<string>();
    for (const a of cand.accesses) {
      if (a.kind === 'call') called.add(a.propName);
      else if (a.kind === 'write') written.add(a.propName);
    }
    if (called.size === 0) continue;
    if (!bindings) bindings = collectBindings(ast, analysis);
    for (const name of called) {
      const props = cand.objExpr.properties.filter((p: any) => extractKeyName(p) === name);
      if (
        written.has(name) ||
        props.length === 0 ||
        !props.every((p: any) => isThisFreeCallee(p.value, analysis, bindings!))
      ) {
        cand.safe = false;
        break;
      }
    }
  }

  // Step 4: rewrite keys + accesses for surviving candidates.
  let renamedCount = 0;
  for (const cand of candidates.values()) {
    if (!cand.safe) continue;

    const allNames = new Set<string>();
    for (const p of cand.objExpr.properties) {
      const k = extractKeyName(p);
      if (k !== null) allNames.add(k);
    }
    for (const a of cand.accesses) allNames.add(a.propName);
    if (allNames.size === 0) continue;

    // One more SKIP_PROPS sweep — an access to a protected property
    // may have slipped past the earlier check if the declaration
    // didn't define it (e.g., `obj.toString`).
    let bail = false;
    for (const n of allNames) if (SKIP_PROPS.has(n)) { bail = true; break; }
    if (bail) continue;

    const rename = new Map<string, string>();
    for (const n of allNames) rename.set(n, gen());

    // Declaration side.
    for (const p of cand.objExpr.properties) {
      const kname = extractKeyName(p);
      if (kname === null) continue;
      const newName = rename.get(kname);
      if (!newName) continue;
      p.key = { type: 'Identifier', name: newName };
      // Shorthand keeps key.name === value.name in sync. After rename
      // they diverge, so drop shorthand so the printer emits both
      // sides explicitly. (secondPass also does this, but doing it
      // here keeps the tree internally consistent between passes.)
      if (p.shorthand) p.shorthand = false;
    }

    // Access side.
    for (const a of cand.accesses) {
      a.memberNode.property = { type: 'Identifier', name: rename.get(a.propName)! };
    }

    renamedCount++;
  }

  return renamedCount;
}
