import * as estraverse from 'estraverse';
import { parse } from '../babelParser';
import { VISITOR_KEYS } from '../visitorKeys';

/** Static visibility only: this does not execute decoders or reconstruct CFGs. */
export interface SourceEvidence {
  strings: string[];
  numbers: number[];
  numericArrays: Array<Array<number | undefined>>;
  operatorSequences: string[][];
}

/** Evaluate only numeric AST operations, without executing any source code. */
function numericValue(node: any, values: WeakMap<object, number>): number | undefined {
  if (node.type === 'NumericLiteral') return node.value;
  if (node.type === 'UnaryExpression') {
    const n = values.get(node.argument);
    if (n === undefined) return;
    switch (node.operator) {
      case '+': return +n;
      case '-': return -n;
      case '~': return ~n;
    }
  }
  if (node.type !== 'BinaryExpression') return;
  const a = values.get(node.left), b = values.get(node.right);
  if (a === undefined || b === undefined) return;
  switch (node.operator) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return a / b;
    case '%': return a % b;
    case '**': return a ** b;
    case '^': return a ^ b;
    case '&': return a & b;
    case '|': return a | b;
    case '<<': return a << b;
    case '>>': return a >> b;
    case '>>>': return a >>> b;
  }
  return;
}

export function isFunctionNode(node: any): boolean {
  return ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
    'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod'].includes(node.type);
}

/** Parse literals and operators so escaping, comments and formatting cannot fool a check. */
export function inspectSource(code: string): SourceEvidence {
  const ast: any = parse(code);
  const evidence: SourceEvidence = { strings: [], numbers: [], numericArrays: [], operatorSequences: [] };
  const values = new WeakMap<object, number>();
  type Operator = { operator: string; position: number };
  const scopes: Operator[][] = [[]];
  const allScopes = [scopes[0]];
  estraverse.traverse(ast.program, {
    keys: VISITOR_KEYS,
    enter(node: any) {
      if (isFunctionNode(node)) {
        const scope: Operator[] = [];
        scopes.push(scope);
        allScopes.push(scope);
      }
      if (node.type === 'StringLiteral' || node.type === 'DirectiveLiteral') evidence.strings.push(node.value);
      if (node.type === 'RegExpLiteral') evidence.strings.push(node.pattern);
      if (node.type === 'TemplateElement') {
        evidence.strings.push(node.value.raw);
        if (node.value.cooked != null) evidence.strings.push(node.value.cooked);
      }
      if (node.type === 'BinaryExpression') {
        // The operator is after the left operand; sorting also handles nested
        // expressions whose preorder traversal differs from lexical order.
        scopes[scopes.length - 1].push({ operator: node.operator, position: node.left.end });
      }
    },
    leave(node: any) {
      const value = numericValue(node, values);
      if (value !== undefined) {
        values.set(node, value);
        evidence.numbers.push(value);
      }
      if (node.type === 'ArrayExpression' && node.elements.length > 0) {
        evidence.numericArrays.push(node.elements.map((e: any) => e ? values.get(e) : undefined));
      }
      if (isFunctionNode(node)) scopes.pop();
    },
    fallback: 'iteration',
  } as any);
  evidence.operatorSequences = allScopes.map(scope =>
    scope.sort((a, b) => a.position - b.position).map(entry => entry.operator));
  return evidence;
}

/** A lexical subsequence within one function/program, not proof of data flow. */
export function hasOperatorSequence(evidence: SourceEvidence, operators: string[]): boolean {
  return evidence.operatorSequences.some(sequence => {
    let matched = 0;
    for (const operator of sequence) {
      if (operator === operators[matched]) matched++;
      if (matched === operators.length) return true;
    }
    return operators.length === 0;
  });
}

export function hasByteSequence(evidence: SourceEvidence, bytes: number[]): boolean {
  return evidence.numericArrays.some(array => array.some((_, start) =>
    start + bytes.length <= array.length && bytes.every((byte, i) => array[start + i] === byte)));
}
