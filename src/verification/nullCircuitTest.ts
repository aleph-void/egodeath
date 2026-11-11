/**
 * Structural similarity heuristic for real and null functions. Similar counts
 * do not establish indistinguishability or resistance to reverse engineering.
 */

import { obfuscate } from '../obfuscator';
import { parse } from '../babelParser';
import * as estraverse from 'estraverse';
import { VISITOR_KEYS } from '../visitorKeys';
import { isFunctionNode } from './sourceAnalysis';

// ---- Structural metrics ----

/**
 * Fingerprint of an obfuscated output's structural properties.
 * These are the features a static analyzer would use to distinguish
 * real from null code.
 */
export interface StructuralFingerprint {
  /** Total character count */
  totalChars: number;
  /** Number of unique parser tokens (excluding comments) */
  uniqueTokens: number;
  /** Ratio of alphanumeric to symbolic characters */
  alphaSymRatio: number;
  /** Number of functions, arrows and methods */
  functionCount: number;
  /** Number of if statements */
  ifCount: number;
  /** Number of loop statements */
  loopCount: number;
  /** Number of return statements */
  returnCount: number;
  /** Number of var/let/const declarations */
  varDeclCount: number;
  /** Number of assignments and initialized declarators */
  assignmentCount: number;
  /** Number of binary and logical expressions */
  binaryOpCount: number;
  /** Number of string literals (hex-encoded) in the array */
  stringArraySize: number;
  /** Average AST depth of statements/declarations (Program is depth zero) */
  avgNestingDepth: number;
  /** Number of eval() calls */
  evalCount: number;
  /** Number of switch cases */
  switchCaseCount: number;
}

/**
 * Compute structural fingerprint of obfuscated code.
 */
export function computeFingerprint(code: string): StructuralFingerprint {
  const totalChars = code.length;

  const ast: any = parse(code);
  const tokens = ast.tokens.filter((token: any) => token.type?.label && token.type.label !== 'eof');
  const uniqueTokens = new Set(tokens.map((token: any) =>
    `${token.type.label}:${String(token.value ?? '')}`)).size;

  // Retain this surface-size metric, but classify Unicode identifier letters
  // as letters rather than treating the obfuscator's names as punctuation.
  const alphaChars = (code.match(/[\p{L}\p{N}]/gu) || []).length;
  const symChars = (code.match(/[^\p{L}\p{N}\s]/gu) || []).length;
  const alphaSymRatio = symChars > 0 ? alphaChars / symChars : alphaChars;

  let functionCount = 0, ifCount = 0, loopCount = 0, returnCount = 0;
  let varDeclCount = 0, assignmentCount = 0, binaryOpCount = 0;
  let stringArraySize = 0, evalCount = 0, switchCaseCount = 0;
  let depth = -1, totalDepth = 0, depthSamples = 0;
  estraverse.traverse(ast.program, {
    keys: VISITOR_KEYS,
    enter(node: any) {
      depth++;
      if (/Statement$|Declaration$/.test(node.type)) {
        totalDepth += depth;
        depthSamples++;
      }
      if (isFunctionNode(node)) functionCount++;
      if (node.type === 'IfStatement') ifCount++;
      if (['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement'].includes(node.type)) loopCount++;
      if (node.type === 'ReturnStatement') returnCount++;
      if (node.type === 'VariableDeclaration') varDeclCount++;
      if (node.type === 'AssignmentExpression' || (node.type === 'VariableDeclarator' && node.init)) assignmentCount++;
      if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') binaryOpCount++;
      if (node.type === 'ArrayExpression') {
        stringArraySize += node.elements.filter((e: any) =>
          e?.type === 'StringLiteral' && /^[0-9a-f]{4,}$/i.test(e.value)).length;
      }
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'eval') evalCount++;
      if (node.type === 'SwitchCase' && node.test !== null) switchCaseCount++;
    },
    leave() { depth--; },
    fallback: 'iteration',
  } as any);
  const avgNestingDepth = depthSamples > 0 ? totalDepth / depthSamples : 0;

  return {
    totalChars,
    uniqueTokens,
    alphaSymRatio,
    functionCount,
    ifCount,
    loopCount,
    returnCount,
    varDeclCount,
    assignmentCount,
    binaryOpCount,
    stringArraySize,
    avgNestingDepth,
    evalCount,
    switchCaseCount,
  };
}

/**
 * Compute similarity score between two fingerprints.
 * Returns a value between 0 (completely different) and 1 (identical).
 *
 * Uses normalized metric comparison — each metric contributes equally
 * to the final score. A metric is considered "similar" if the values
 * are within 50% of each other.
 */
export function computeSimilarity(a: StructuralFingerprint, b: StructuralFingerprint): number {
  const metrics: (keyof StructuralFingerprint)[] = [
    'totalChars', 'uniqueTokens', 'alphaSymRatio',
    'functionCount', 'ifCount', 'loopCount', 'returnCount',
    'varDeclCount', 'assignmentCount', 'binaryOpCount',
    'stringArraySize', 'avgNestingDepth', 'evalCount', 'switchCaseCount',
  ];

  let totalSimilarity = 0;
  for (const key of metrics) {
    const va = a[key] as number;
    const vb = b[key] as number;
    const max = Math.max(Math.abs(va), Math.abs(vb), 1);
    const diff = Math.abs(va - vb);
    // Similarity for this metric: 1 when identical, 0 when one is 2x the other
    totalSimilarity += Math.max(0, 1 - diff / max);
  }

  return totalSimilarity / metrics.length;
}

// ---- Null circuit generation ----

/**
 * Generate a "null" function that has the same general shape as the
 * original but does nothing useful. It:
 * - Has the same number of parameters
 * - Has a similar number of variable declarations
 * - Has similar control flow (if/else, loops)
 * - Returns undefined (or a constant)
 *
 * This supplies a structural comparison baseline, not a cryptographic test.
 */
export function generateNullFunction(
  name: string,
  paramCount: number,
  statementCount: number,
): string {
  const params = Array.from({ length: paramCount }, (_, i) => `p${i}`).join(', ');
  const stmts: string[] = [];

  // Generate similar-looking but useless statements.
  // Track which variables have been declared to avoid ReferenceErrors.
  const declared = new Set<string>();
  for (let i = 0; i < statementCount; i++) {
    const kind = i % 5;
    const input = paramCount > 0 ? 'p0' : '0';
    const lastVar = declared.size > 0 ? Array.from(declared).pop()! : input;
    switch (kind) {
      case 0:
        stmts.push(`  var v${i} = ${input} + ${i + 1};`);
        declared.add(`v${i}`);
        break;
      case 1:
        stmts.push(`  ${lastVar} = ${lastVar} * ${i + 2};`);
        break;
      case 2:
        stmts.push(`  if (${lastVar} > ${i * 10}) { ${lastVar} = ${lastVar} - ${i}; }`);
        break;
      case 3:
        stmts.push(`  var v${i} = ${lastVar} + ${input};`);
        declared.add(`v${i}`);
        break;
      case 4:
        stmts.push(`  ${lastVar} = ${lastVar} ^ ${i * 7};`);
        break;
    }
  }

  // Always return undefined (null circuit)
  stmts.push('  return;');

  return `function ${name}(${params}) {\n${stmts.join('\n')}\n}`;
}

// ---- Test runner ----

export interface NullCircuitTestResult {
  /** The real function's structural fingerprint */
  realFingerprint: StructuralFingerprint;
  /** The null function's structural fingerprint */
  nullFingerprint: StructuralFingerprint;
  /** Similarity score (0-1) — higher is better for the obfuscator */
  similarity: number;
  /** Per-metric comparison */
  metricComparison: { metric: string; real: number; null_: number; ratio: number }[];
  /** Overall assessment */
  pass: boolean;
  /** Threshold used */
  threshold: number;
}

/**
 * Run the null circuit test.
 *
 * Obfuscates a real function and a null function with the same shape,
 * then compares their structural fingerprints. Returns a similarity
 * score — higher means the obfuscator is doing a better job of making
 * real and null code indistinguishable.
 *
 * @param realCode     The real function source code
 * @param paramCount   Number of parameters in the function
 * @param stmtCount    Number of statements in the function body
 * @param threshold    Minimum similarity to pass (default 0.5)
 * @param targetTokens Token budget for obfuscation
 */
export function runNullCircuitTest(
  realCode: string,
  paramCount: number,
  stmtCount: number,
  threshold: number = 0.5,
  targetTokens: number = 10000,
): NullCircuitTestResult {
  // Generate a null function with similar shape
  const nullCode = generateNullFunction('nullFn', paramCount, stmtCount);

  // Obfuscate both with the same settings
  const obfReal = obfuscate(realCode, { targetTokens });
  const obfNull = obfuscate(nullCode, { targetTokens });

  // Compute fingerprints
  const realFp = computeFingerprint(obfReal);
  const nullFp = computeFingerprint(obfNull);

  // Compute similarity
  const similarity = computeSimilarity(realFp, nullFp);

  // Per-metric comparison
  const metrics: (keyof StructuralFingerprint)[] = [
    'totalChars', 'uniqueTokens', 'alphaSymRatio',
    'functionCount', 'ifCount', 'loopCount', 'returnCount',
    'varDeclCount', 'assignmentCount', 'binaryOpCount',
    'stringArraySize', 'avgNestingDepth', 'evalCount', 'switchCaseCount',
  ];
  const metricComparison = metrics.map(m => {
    const rv = realFp[m] as number;
    const nv = nullFp[m] as number;
    return {
      metric: m,
      real: rv,
      null_: nv,
      ratio: Math.max(rv, nv, 1) > 0 ? Math.min(rv, nv) / Math.max(rv, nv, 1) : 1,
    };
  });

  return {
    realFingerprint: realFp,
    nullFingerprint: nullFp,
    similarity,
    metricComparison,
    pass: similarity >= threshold,
    threshold,
  };
}
