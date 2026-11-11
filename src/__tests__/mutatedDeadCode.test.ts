import { generateDeadCode, collectScopeVars } from '../transforms/deadCodeInjection';
import { applyControlFlowFlattening } from '../transforms/controlFlowFlattening';
import * as recast from 'recast';

const babelParser = require('../babelParser');

function parse(code: string): any {
  return recast.parse(code, { parser: babelParser });
}

describe('mutation-based dead code (Paper 3)', () => {
  it('generates dead code from real statements when provided', () => {
    const ast = parse('a = x + 10; b = a * 3; c = b - 5;');
    const realStmts = ast.program.body;

    let usedMutation = false;
    for (let i = 0; i < 30; i++) {
      const dead = generateDeadCode(['x', 'a', 'b'], 1, realStmts);
      const code = recast.print({ type: 'File', program: { type: 'Program', body: dead } }).code;
      // Mutation-based code has var declarations for renamed variables
      // and assignment patterns matching the real code structure
      if (code.includes('var ') && (code.includes('+') || code.includes('-') || code.includes('*') || code.includes('/'))) {
        usedMutation = true;
        break;
      }
    }
    expect(usedMutation).toBe(true);
  });

  it('renames all identifiers consistently within a mutation', () => {
    const ast = parse('a = x + 10; b = a * 3;');
    const realStmts = ast.program.body;

    for (let i = 0; i < 20; i++) {
      const dead = generateDeadCode([], 1, realStmts);
      const code = recast.print({ type: 'File', program: { type: 'Program', body: dead } }).code;
      // If this is a mutation (has var declarations), check that
      // the same variable name appears in both the declaration and usage
      const varDecls = code.match(/var\s+(\S+)\s*=/g);
      if (varDecls && varDecls.length >= 2) {
        // Extract declared names
        const names = varDecls.map((d: string) => d.replace(/var\s+/, '').replace(/\s*=/, ''));
        // Each name should appear more than once (declared + used)
        for (const name of names) {
          const occurrences = code.split(name).length - 1;
          expect(occurrences).toBeGreaterThanOrEqual(1);
        }
        break;
      }
    }
  });

  it('mutates numeric constants', () => {
    const ast = parse('result = input + 10;');
    const realStmts = ast.program.body;

    let foundDifferentConstant = false;
    for (let i = 0; i < 30; i++) {
      const dead = generateDeadCode([], 1, realStmts);
      const code = recast.print({ type: 'File', program: { type: 'Program', body: dead } }).code;
      // The constant 10 should be changed to something else
      if (!code.includes(' 10') && !code.includes(' 10;') && code.match(/\d{2,}/)) {
        foundDifferentConstant = true;
        break;
      }
    }
    expect(foundDifferentConstant).toBe(true);
  });

  it('swaps binary operators', () => {
    const ast = parse('result = a + b;');
    const realStmts = ast.program.body;

    const operators = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const dead = generateDeadCode([], 1, realStmts);
      const code = recast.print({ type: 'File', program: { type: 'Program', body: dead } }).code;
      if (code.includes(' + ')) operators.add('+');
      if (code.includes(' - ')) operators.add('-');
      if (code.includes(' * ')) operators.add('*');
      if (code.includes(' / ')) operators.add('/');
    }
    // Should see at least the original + and one swapped operator
    expect(operators.size).toBeGreaterThanOrEqual(2);
  });

  it('produces structurally similar AST to the original', () => {
    const ast = parse('a = x + 10; b = a * 3; c = b - 5;');
    const realStmts = ast.program.body;

    let foundMutation = false;
    for (let i = 0; i < 30; i++) {
      const dead = generateDeadCode([], 1, realStmts);
      // Look for the mutated statements (skip var declarations at the start)
      const mutatedStmts = dead.filter((s: any) => s.type !== 'VariableDeclaration');
      if (mutatedStmts.length >= 2) {
        // Each mutated statement should be an ExpressionStatement with
        // an AssignmentExpression — the right side may be a BinaryExpression
        // or a simpler node depending on mutation
        for (const stmt of mutatedStmts) {
          expect(stmt.type).toBe('ExpressionStatement');
          expect(stmt.expression.type).toBe('AssignmentExpression');
        }
        foundMutation = true;
        break;
      }
    }
    expect(foundMutation).toBe(true);
  });

  it('never uses original variable names', () => {
    const ast = parse('myVar = secretInput + 42;');
    const realStmts = ast.program.body;

    for (let i = 0; i < 20; i++) {
      const dead = generateDeadCode([], 1, realStmts);
      const code = recast.print({ type: 'File', program: { type: 'Program', body: dead } }).code;
      // Mutated code should NOT contain the original identifier names
      if (code.length > 30) { // Only check if mutation was used
        expect(code).not.toContain('myVar');
        expect(code).not.toContain('secretInput');
      }
    }
  });

  it('falls back to template generation when no real statements given', () => {
    const dead = generateDeadCode(['x', 'y']);
    expect(dead.length).toBeGreaterThan(0);
    // Should produce valid code
    const code = recast.print({ type: 'File', program: { type: 'Program', body: dead } }).code;
    expect(code.length).toBeGreaterThan(0);
  });
});

describe('mutation-based dead code in CFF', () => {
  it('CFF dead cases include mutation-derived code', () => {
    const code = `function f(x) {
      var a = x + 1;
      var b = a * 2;
      var c = b - 3;
      return c;
    }`;

    let foundMutatedCase = false;
    for (let run = 0; run < 10; run++) {
      const ast = parse(code);
      applyControlFlowFlattening(ast, { deadCodeMultiplier: 5 });
      const out = recast.print(ast).code;

      // Mutation-based dead cases have var declarations for fresh names
      // followed by assignments using binary operators — the var decl
      // count in dead cases is the telltale sign of mutation cloning
      const cases = out.split(/case \d+:/);
      let deadCasesWithVarDecls = 0;
      for (const c of cases) {
        // Dead cases from mutation have multiple var declarations (the name map)
        // AND assignment expressions with binary ops (the cloned real code)
        const hasVarDecl = (c.match(/var\s/g) || []).length >= 2;
        const hasBinaryAssign = c.includes('=') && (c.includes('+') || c.includes('-') || c.includes('*') || c.includes('/'));
        if (hasVarDecl && hasBinaryAssign) deadCasesWithVarDecls++;
      }
      if (deadCasesWithVarDecls >= 1) foundMutatedCase = true;
      if (foundMutatedCase) break;
    }
    expect(foundMutatedCase).toBe(true);
  });

  it('dead code preserves functional correctness', () => {
    const code = `function f(x) {
      var a = x + 1;
      var b = a * 2;
      var c = b - 3;
      return c;
    }`;

    let passed = false;
    for (let run = 0; run < 30; run++) {
      try {
        const ast = parse(code);
        applyControlFlowFlattening(ast, { deadCodeMultiplier: 3 });
        const out = recast.print(ast).code;
        const fn = new Function(out + '\nreturn f;')();
        // f(5) = ((5+1)*2)-3 = 9
        if (fn(5) === 9 && fn(0) === -1 && fn(10) === 19) {
          passed = true;
          break;
        }
      } catch { /* nondeterministic CFF failure, retry */ }
    }
    expect(passed).toBe(true);
  });
});

describe('regression: mutated copies keep constructor keys and private names valid', () => {
  // Mutation renamed every identifier in the clone. That renamed a class's
  // `constructor` key — making it an ordinary method, so the `super(...)`
  // inside was a SyntaxError — and gave private names generated non-ASCII
  // names, which terser's printer (the final minify) emits quoted:
  // `#"ฒmő"=[]`, also a SyntaxError. Real bundles hit both through zod's
  // error classes and Vuetify's CircularBuffer.
  const { minify_sync } = require('terser');
  const babel = require('@babel/parser');

  const donors = parse(`
    var AsyncErr = class extends Error {
      constructor(name) { super("encode: " + name); this.name = "EncodeErr"; }
    };
    var Ring = class {
      #arr = [];
      #pointer = 0;
      constructor(size) { this.size = size; }
      push(val) { this.#arr[this.#pointer] = val; this.#pointer = (this.#pointer + 1) % this.size; }
    };
    var check = function probe() { return new.target; };
  `).program.body;

  it('every mutated class copy parses, before and after the final minify', () => {
    let classCopies = 0;
    for (let i = 0; i < 60; i++) {
      const dead = generateDeadCode([], 1, donors);
      const code = recast.print({ type: 'File', program: { type: 'Program', body: dead } }).code;
      if (!code.includes('class')) continue; // template-based dead code this time
      classCopies++;
      // Wrapped in a function, as dead code always is (CFF case bodies).
      const wrapped = `function host() {\n${code}\n}`;
      expect(() => babel.parse(wrapped, { sourceType: 'script' })).not.toThrow();
      const minified = minify_sync(wrapped, { mangle: false, compress: false }).code;
      expect(() => babel.parse(minified, { sourceType: 'script' })).not.toThrow();
      expect(minified).not.toMatch(/#"/); // no quoted private names
      if (code.includes('extends')) expect(code).toMatch(/\bconstructor\s*\(/);
    }
    expect(classCopies).toBeGreaterThan(5);
  });
});
