import { VISITOR_KEYS as EXTRA_VISITOR_KEYS } from '../visitorKeys';
import * as estraverse from 'estraverse';

/**
 * Move static template text into StringLiterals for string-array extraction.
 * Keep each interpolation in a minimal `${expression}` template so the engine
 * performs ToString with the string hint, preserves Symbol errors, and coerces
 * each value before evaluating the next interpolation. Neither `+ value` nor
 * `String(value)` has identical semantics. Tagged templates stay untouched.
 */

/** Build a babel-shape StringLiteral for the given cooked value. */
function stringLit(value: string): any {
  return { type: 'StringLiteral', value };
}

function cookedOf(q: any): string {
  if (!q || !q.value) return '';
  const v = q.value;
  return typeof v.cooked === 'string' ? v.cooked : (typeof v.raw === 'string' ? v.raw : '');
}

function flattenTemplateLiteral(tl: any): any {
  const quasis: any[] = tl.quasis || [];
  const expressions: any[] = tl.expressions || [];

  // Pure string template (no interpolations) — one quasi, no
  // expressions — becomes a plain StringLiteral.
  if (expressions.length === 0) {
    return stringLit(cookedOf(quasis[0]));
  }

  // Anchor the chain with the first quasi (may be ""); this makes the
  // leftmost `+` a string-concat so `${1}${2}` → "12" not 3. We emit
  // the empty anchor unconditionally for templates that start with an
  // interpolation; for templates that start with static text, the
  // first StringLiteral IS that text and no extra "" is needed.
  let acc: any = stringLit(cookedOf(quasis[0]));

  for (let i = 0; i < expressions.length; i++) {
    const interpolation = {
      type: 'TemplateLiteral',
      quasis: [false, true].map(tail => ({
        type: 'TemplateElement', value: { raw: '', cooked: '' }, tail,
      })),
      expressions: [expressions[i]],
    };
    acc = { type: 'BinaryExpression', operator: '+', left: acc, right: interpolation };
    const q = quasis[i + 1];
    const qv = cookedOf(q);
    if (qv.length > 0) {
      acc = {
        type: 'BinaryExpression',
        operator: '+',
        left: acc,
        right: stringLit(qv),
      };
    }
  }
  return acc;
}

/**
 * Walk the program AST and replace every plain TemplateLiteral with a
 * BinaryExpression chain.  Uses `leave` so nested templates are
 * flattened bottom-up — the outer flatten then reads already-
 * flattened children and splices them in as ordinary expressions.
 */
export function applyTemplateLiteralFlattening(ast: any): void {
  estraverse.replace(ast.program, {
    keys: EXTRA_VISITOR_KEYS,
    leave(node: any, parent: any) {
      if (node.type !== 'TemplateLiteral') return;
      // Preserve the quasi of a tagged template — the tag function
      // reads it directly and depends on both its structure and its
      // .raw side, which a concatenation chain cannot reproduce.
      if (parent && parent.type === 'TaggedTemplateExpression' && parent.quasi === node) {
        return;
      }
      return flattenTemplateLiteral(node);
    },
    fallback: 'iteration',
  } as any);
}
