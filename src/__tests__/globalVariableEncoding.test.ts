import { applyGlobalVariableEncoding } from '../transforms/globalVariableEncoding';
import { obfuscate } from '../obfuscator';
import { resetCapturedGlobals, flushCapturedGlobals } from '../capturedGlobals';
import * as recast from 'recast';

const babelParser = require('../babelParser');

function parse(code: string): any {
  return recast.parse(code, { parser: babelParser });
}

function transform(code: string): string {
  resetCapturedGlobals();
  const ast = parse(code);
  applyGlobalVariableEncoding(ast);
  flushCapturedGlobals(ast);
  return recast.print(ast).code;
}

describe('applyGlobalVariableEncoding', () => {
  it('replaces Math with eval/replace expression', () => {
    const out = transform('var x = Math.random();');
    expect(out).toContain('eval(');
    expect(out).toContain('.replace(');
    expect(out).not.toMatch(/\bMath\b(?!.*replace)/);
  });

  it('replaces Array with eval/replace expression', () => {
    const out = transform('var x = new Array(3);');
    expect(out).toContain('eval(');
  });

  it('replaces Object with eval/replace expression', () => {
    const out = transform('var x = Object.keys({});');
    expect(out).toContain('eval(');
  });

  it('replaces JSON with eval/replace expression', () => {
    const out = transform('var x = JSON.stringify({});');
    expect(out).toContain('eval(');
  });

  it('uses unique suffixes for each instance', () => {
    const out = transform('var a = Math.random(); var b = Math.floor(1.5);');
    // Extract the strings inside quotes (the "Math<suffix>" values)
    const matches = out.match(/"Math[a-zA-Z0-9]+"/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(2);
    // They should be different
    expect(matches![0]).not.toBe(matches![1]);
  });

  it('does not encode property accesses named after globals', () => {
    const out = transform('var obj = {}; obj.Math = 1;');
    // obj.Math should remain as a property, not eval-encoded
    expect(out).not.toContain('eval(');
  });

  it('does not encode variable declarations shadowing globals', () => {
    const out = transform('var Math = 42;');
    expect(out).not.toContain('eval(');
  });

  it('does not encode function parameters named after globals', () => {
    const out = transform('function f(Array) { return Array; }');
    // Neither the parameter nor its in-body reference may be encoded: `Array`
    // here is the local parameter, not the global. Encoding `return Array` to a
    // real-global read would ignore the argument entirely.
    expect(out).toContain('function f(Array)');
    expect(out).not.toContain('eval(');
  });

  it('does not encode references to a locally-declared global name', () => {
    // Regression: lodash probes the environment with
    //   var Buffer = moduleExports ? context.Buffer : undefined;
    //   ... Buffer ? Buffer.isBuffer : undefined
    // Encoding those `Buffer`s to `eval("Buffer")` (the real global) made
    // `_.isBuffer` ignore a missing Buffer. A name declared as a local binding
    // anywhere in the program must not be encoded.
    const out = transform(
      'var Buffer = cond ? ctx.Buffer : undefined; var n = Buffer ? Buffer.isBuffer : undefined;',
    );
    expect(out).not.toContain('eval(');
    expect(out).toContain('Buffer ? Buffer.isBuffer');
  });

  it('does not encode object literal keys', () => {
    const out = transform('var x = { Math: 1, Object: 2 };');
    expect(out).not.toContain('eval(');
  });

  it('does not encode a global name used as an assignment target', () => {
    // `eval(...)` is not an lvalue — encoding the LHS would produce
    // "Invalid left-hand side in assignment".
    const out = transform('Math = 1;');
    expect(out).not.toContain('eval(');
    expect(out).toContain('Math = 1');
  });

  it('does not encode a global name in an update expression', () => {
    const out = transform('Math++;');
    expect(out).not.toContain('eval(');
    expect(out).toContain('Math++');
  });

  it('does not encode a for-in binding target without a declaration kind', () => {
    const out = transform('for (Math in obj) {}');
    expect(out).not.toContain('eval(');
    expect(out).toContain('for (Math in obj)');
  });

  it('does not encode array-destructuring binding targets', () => {
    const out = transform('[Math] = arr;');
    expect(out).not.toContain('eval(');
  });

  it('does not encode a rest-element destructuring target', () => {
    const out = transform('[...Math] = arr;');
    expect(out).not.toContain('eval(');
  });

  it('does not encode an assignment-pattern (default) target', () => {
    const out = transform('[Math = 5] = arr;');
    expect(out).not.toContain('eval(');
  });

  it('conservatively does not encode an object-property value', () => {
    // `{ foo: Math }` — Math is a reference, but distinguishing a literal
    // value from a destructuring binding needs grandparent info, so the
    // transform errs toward correctness and leaves it alone.
    const out = transform('var x = { foo: Math };');
    expect(out).not.toContain('eval(');
  });

  it('does not encode a global-named statement label', () => {
    const out = transform('Math: x = 1;');
    expect(out).not.toContain('eval(');
    expect(out).toContain('Math:');
  });

  it('handles object-pattern rest bindings when collecting declared names', () => {
    // Exercises the ObjectPattern rest-element path in declared-name
    // collection; a shadowing global binding here is left untouched.
    const out = transform('var {Math, ...rest} = obj; var y = Math.PI;');
    // Math is declared as a local binding, so every Math reference is skipped.
    expect(out).not.toContain('eval(');
  });

  it('handles multiple different globals', () => {
    const out = transform('var a = Math.PI; var b = Array.isArray([]); var c = Object.keys({});');
    // Should have 3 eval calls
    const evalCount = (out.match(/eval\(/g) || []).length;
    expect(evalCount).toBe(3);
  });
});

describe('regression: global-named members, params and labels (Babel node shapes)', () => {
  // isGlobalReference only knew ESTree's MethodDefinition. egodeath parses
  // with Babel, so object/class method names, getters and class fields
  // (ObjectMethod / ClassMethod / ClassProperty), params on ClassMethod /
  // ObjectMethod, and `break Math` / `continue Math` were rewritten to
  // eval(...): SyntaxErrors at ratio > 10
  // (e.g. `eval(…)(x = 1) { this.… }` for a class method named after a
  // global).
  const runReturning = (code: string, expr: string): unknown => {
    const out = transform(code);
    return new Function(out + '\nreturn (' + expr + ');')();
  };

  it.each([
    ['object method / getter names', 'var o = { Math(x) { return "m" + x; }, get JSON() { return "j"; } };', '[o.Math(1), o.JSON]', ['m1', 'j']],
    ['class method / static method names', 'class C { Math(x) { return "m" + x; } static Date() { return "d"; } }', '[new C().Math(2), C.Date()]', ['m2', 'd']],
    ['class field names', 'class C { Math = 3; static JSON = "j"; }', '[new C().Math, C.JSON]', [3, 'j']],
    ['class / object method params', 'class C { run(Math) { return Math + 1; } } var o = { go(JSON) { return JSON * 2; } };', '[new C().run(4), o.go(5)]', [5, 10]],
    ['break / continue labels', 'var n = 0; Math: for (var i = 0; i < 3; i++) { for (;;) { n++; continue Math; } } JSON: { n += 10; break JSON; }', '[n]', [13]],
  ])('leaves %s alone and runs correctly', (_label, code, expr, expected) => {
    expect(() => parse(transform(code))).not.toThrow();
    expect(runReturning(code, expr)).toEqual(expected);
  });

  it('still encodes real global references inside those members', () => {
    const out = transform('class C { Math(x) { return Math.max(x, 1); } }');
    expect(out).toContain('eval(');
    expect(new Function(out + '\nreturn new C().Math(5);')()).toBe(5);
  });
});

describe('regression: global-named properties in optional chains', () => {
  // isGlobalReference skipped the property of a MemberExpression but not of
  // an OptionalMemberExpression, which is what Babel produces for every link
  // of an optional chain. `vm.qmp?.close()` (close is a window global, from
  // jsdom) became `vm.qmp?.eval(...)()`, a TypeError at runtime, which in an
  // Electron main process surfaced as an uncaught-exception dialog.
  it.each([
    ['optional property', 'var o = { Math: 7 }; var r = o?.Math;', 7],
    ['optional method call', 'var q = { close() { return 2; } }; var r = q?.close();', 2],
    ['property after an optional link', 'var a = { b: { JSON: 3 } }; var r = a?.b.JSON;', 3],
    ['optional call on a global-named method', 'var o = { Math() { return 1; } }; var r = o?.Math?.();', 1],
  ])('leaves the %s alone', (_label, code, expected) => {
    const out = transform(code);
    expect(out).not.toContain('eval(');
    expect(new Function(out + '\nreturn r;')()).toBe(expected);
  });

  it('still encodes a global used as the object of an optional chain', () => {
    const out = transform('var r = Math?.max(2, 5);');
    expect(out).toContain('eval(');
    expect(new Function(out + '\nreturn r;')()).toBe(5);
  });
});

describe('global encoding functional correctness', () => {
  it('eval/replace resolves Math correctly', () => {
    const out = transform('var x = Math.floor(1.7);');
    const fn = new Function(out + '\nreturn x;');
    expect(fn()).toBe(1);
  });

  it('eval/replace resolves Array correctly', () => {
    const out = transform('var x = Array.isArray([1, 2, 3]);');
    const fn = new Function(out + '\nreturn x;');
    expect(fn()).toBe(true);
  });

  it('eval/replace resolves Object correctly', () => {
    const out = transform('var x = Object.keys({a: 1, b: 2});');
    const fn = new Function(out + '\nreturn x;');
    expect(fn()).toEqual(['a', 'b']);
  });

  it('eval/replace resolves JSON correctly', () => {
    const out = transform('var x = JSON.stringify({a: 1});');
    const fn = new Function(out + '\nreturn x;');
    expect(fn()).toBe('{"a":1}');
  });

  it('eval/replace resolves String correctly', () => {
    const out = transform('var x = String(42);');
    const fn = new Function(out + '\nreturn x;');
    expect(fn()).toBe('42');
  });

  it('eval/replace resolves Number correctly', () => {
    const out = transform('var x = Number("42");');
    const fn = new Function(out + '\nreturn x;');
    expect(fn()).toBe(42);
  });

  it('eval/replace works with new keyword', () => {
    const out = transform('var x = new RegExp("abc");');
    const fn = new Function(out + '\nreturn x.test("xabcx");');
    expect(fn()).toBe(true);
  });

  it('works with chained member access', () => {
    const out = transform('var x = Math.floor(Math.random() * 100);');
    const fn = new Function(out + '\nreturn x;');
    const result = fn();
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(100);
  });
});

describe('full pipeline with global encoding', () => {
  it('no readable global names in obfuscated output', () => {
    const code = 'var x = Math.floor(1.5); var y = JSON.stringify({a:1});';
    const out = obfuscate(code, { targetTokens: 10000 });
    // Global names should not appear as readable identifiers
    expect(out).not.toMatch(/\bMath\b/);
    expect(out).not.toMatch(/\bJSON\b/);
  });

  it('strings used in global encoding go into the string array', () => {
    const code = 'var x = Math.PI;';
    const out = obfuscate(code, { targetTokens: 10000 });
    // The output should NOT contain any "Math..." string literal directly
    // because it should be in the jsfuck-encoded string array
    expect(out).not.toMatch(/"Math/);
  });
});
