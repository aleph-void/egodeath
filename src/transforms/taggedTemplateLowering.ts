import { VISITOR_KEYS } from '../visitorKeys';
import * as estraverse from 'estraverse';
import { parseExpression } from '@babel/parser';
import { captureGlobal } from '../capturedGlobals';
import { gen } from '../random';

/**
 * Tagged Template Lowering
 *
 * Rewrites the tagged templates that the final Terser pass cannot
 * round-trip into an equivalent call with an explicit, per-site cached
 * template object:
 *
 *   tag`a${x}\u{`
 *   →  tag(_c || (_c = O.freeze(O.defineProperty(["a", void 0], "raw",
 *          { value: O.freeze(["a", "\\u{"]) }))), x)
 *
 * where `_c` is a fresh program-level `var` (one per site, so the tag
 * sees the same frozen template object on every evaluation, exactly like
 * the spec's per-site template registry) and `O` is the captured
 * `Object` intrinsic. The cooked/raw strings become ordinary string
 * literals, so string-array extraction encodes them afterwards.
 *
 * Two shapes are lowered; every other tagged template is left alone:
 *
 *   1. Invalid escapes (ES2018 template literal revision): a quasi whose
 *      cooked value is undefined, e.g. String.raw`\u{` or `\u{110000}`.
 *      Terser's tokenizer rejects some of these (`\u{` with no closing
 *      brace, out-of-range code points), so minification fails outright.
 *
 *   2. Optional-chain tags: `(o?.tag)`x``. Terser drops the parentheses
 *      when printing, emitting `o?.tag`x``, which is a SyntaxError.
 *      Terser does keep the parentheses in `(o?.tag)(…)`, and a
 *      parenthesized optional chain is still a Reference there, so the
 *      call receives the same `this`.
 *
 * Semantics preserved by the call form: the tag (and its receiver) is
 * evaluated first, then the template object, then the substitutions, then
 * the callability check — the same order as a tagged template's
 * ArgumentListEvaluation. The template object matches the spec shape: a
 * frozen array of cooked strings (undefined for invalid escapes) with a
 * non-enumerable, non-writable, non-configurable `raw` property holding a
 * frozen array of raw strings.
 */

/** Cooked value of a template quasi, or null for an invalid escape. */
function cookRaw(raw: string): string | null {
  try {
    const expr: any = parseExpression('`' + raw + '`');
    const cooked = expr.quasis && expr.quasis[0] && expr.quasis[0].value.cooked;
    return typeof cooked === 'string' ? cooked : null;
  } catch {
    return null;
  }
}

function quasiStrings(quasi: any): { cooked: Array<string | null>; raw: string[] } {
  const cooked: Array<string | null> = [];
  const raw: string[] = [];
  for (const el of quasi.quasis) {
    // TRV normalizes <CR><LF> and <CR> to <LF>.
    const r = String(el.value.raw).replace(/\r\n?/g, '\n');
    raw.push(r);
    const c = el.value.cooked;
    cooked.push(typeof c === 'string' ? c : c === null ? null : cookRaw(r));
  }
  return { cooked, raw };
}

function unwrapParens(node: any): any {
  while (node && node.type === 'ParenthesizedExpression') node = node.expression;
  return node;
}

function isOptionalChain(node: any): boolean {
  const n = unwrapParens(node);
  return !!n && (
    n.type === 'OptionalMemberExpression' ||
    n.type === 'OptionalCallExpression' ||
    n.type === 'ChainExpression'
  );
}

const str = (value: string) => ({ type: 'StringLiteral', value });
const voidZero = () => ({
  type: 'UnaryExpression', operator: 'void', prefix: true,
  argument: { type: 'NumericLiteral', value: 0 },
});
const id = (name: string) => ({ type: 'Identifier', name });
const member = (object: any, name: string) => ({
  type: 'MemberExpression', object, property: id(name), computed: false,
});
const call = (callee: any, args: any[]) => ({ type: 'CallExpression', callee, arguments: args });

/**
 * Lower every tagged template that the final minifier cannot reproduce.
 * Returns the number of sites rewritten.
 */
export function applyTaggedTemplateLowering(ast: any): number {
  const cacheNames: string[] = [];

  estraverse.replace(ast.program, {
    keys: VISITOR_KEYS,
    leave(node: any) {
      if (node.type !== 'TaggedTemplateExpression') return;
      const { cooked, raw } = quasiStrings(node.quasi);
      const invalidEscape = cooked.some(c => c === null);
      const optionalTag = isOptionalChain(node.tag);
      if (!invalidEscape && !optionalTag) return;

      const objectRef = captureGlobal(ast, 'Object');
      const cache = gen();
      cacheNames.push(cache);

      const rawArray = { type: 'ArrayExpression', elements: raw.map(str) };
      const cookedArray = {
        type: 'ArrayExpression',
        elements: cooked.map(c => (c === null ? voidZero() : str(c))),
      };
      const templateObject = call(member(id(objectRef), 'freeze'), [
        call(member(id(objectRef), 'defineProperty'), [
          cookedArray,
          str('raw'),
          {
            type: 'ObjectExpression',
            properties: [{
              type: 'ObjectProperty',
              key: id('value'),
              value: call(member(id(objectRef), 'freeze'), [rawArray]),
              computed: false,
              shorthand: false,
            }],
          },
        ]),
      ]);
      const cached = {
        type: 'LogicalExpression',
        operator: '||',
        left: id(cache),
        right: { type: 'AssignmentExpression', operator: '=', left: id(cache), right: templateObject },
      };

      // Parenthesize an optional-chain callee explicitly: `(o?.tag)(…)`
      // and `o?.tag(…)` differ (the latter short-circuits the call).
      // Other callees keep their node; the printer adds any parentheses
      // they need, and parentheses never change a member callee's `this`.
      const callee = optionalTag
        ? { type: 'ParenthesizedExpression', expression: unwrapParens(node.tag) }
        : node.tag;
      return call(callee, [cached, ...node.quasi.expressions]);
    },
    fallback: 'iteration',
  } as any);

  if (cacheNames.length > 0) {
    ast.program.body.unshift({
      type: 'VariableDeclaration',
      kind: 'var',
      declarations: cacheNames.map(name => ({ type: 'VariableDeclarator', id: id(name), init: null })),
    });
  }
  return cacheNames.length;
}
