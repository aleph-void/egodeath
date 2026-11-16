import * as vm from 'node:vm';
import * as recast from 'recast';
import { obfuscate, obfuscateMultiple } from '../obfuscator';
import { applyControlFlowFlattening } from '../transforms/controlFlowFlattening';
import { applyTemplateLiteralFlattening } from '../transforms/templateLiteralFlattening';
import { thirdPassHandlers } from '../passes/thirdPass';
import { applyTaggedTemplateLowering } from '../transforms/taggedTemplateLowering';

function evaluate(code: string): any {
  const context = { module: { exports: undefined as any } };
  vm.runInNewContext(code, context, { timeout: 2000 });
  return context.module.exports;
}

function parse(code: string): any {
  return recast.parse(code, { parser: require('../babelParser') });
}

function flatten(code: string): string {
  const ast = parse(code);
  applyControlFlowFlattening(ast, { deadCodeMultiplier: 0 });
  return recast.print(ast).code;
}

describe('review: CFF preserves source bindings and branch scopes', () => {
  it.each([
    'function f(_s){var a=_s+1; a+=2; return a;} module.exports=f(10);',
    'var _s=10; function f(){var a=_s+1; a+=2; return a;} module.exports=f();',
    'function f(){var _s=10; var a=()=>_s; return a()+3;} module.exports=f();',
    'function f(v){if(v){let x=1;}else{let x=2;} return 3; var a=0;} module.exports=[f(true),f(false)];',
    'function f(v){var get; if(v){let x=1; get=()=>x;}else{let x=2; get=()=>x;} return get();} module.exports=[f(true),f(false)];',
    'function f(v){var get; if(v){class X{}; get=()=>X.name;}else{class X{}; get=()=>X.name;} return get();} module.exports=[f(true),f(false)];',
  ])('preserves behavior: %s', code => {
    const expected = evaluate(code);
    for (let i = 0; i < 3; i++) {
      expect(evaluate(flatten(code))).toEqual(expected);
    }
  });

  it('preserves a colliding parameter and lexical branches through the full pipeline', () => {
    const code = 'function f(_s){if(_s){let x=1;}else{let x=2;} var a=_s+1; a+=2; return a;} module.exports=[f(10),f(0)];';
    expect(evaluate(obfuscate(code, { targetTokens: 300, stubConsole: false }))).toEqual(evaluate(code));
  });
});

describe('review: dummy parameters preserve arguments semantics', () => {
  it.each([
    'function f(a){arguments[0]=2;return a} module.exports=f(1);',
    'function f(a){a=2;return arguments[0]} module.exports=f(1);',
    'function f(a){var set=()=>{arguments[0]=2};set();return a} module.exports=f(1);',
    'function f(a){var read=()=>arguments.callee;return read()===f} module.exports=f(1);',
    'function f(a,a){return a} module.exports=f(1,2);',
  ])('preserves behavior: %s', code => {
    const ast = parse(code);
    const fn = ast.program.body[0];
    const before = fn.params.length;
    // Check the parameter guard alongside the observable runtime behavior.
    thirdPassHandlers.FunctionDeclaration(fn, ast.program);
    expect(fn.params).toHaveLength(before);
    expect(evaluate(recast.print(ast).code)).toEqual(evaluate(code));
    expect(evaluate(obfuscate(code, { targetTokens: 1, stubConsole: false }))).toEqual(evaluate(code));
  });
});

describe('review: template interpolation retains native coercion', () => {
  it.each([
    'var x={toString(){return "string"},valueOf(){return 123}}; module.exports=`${x}`;',
    'var log=[]; var x={[Symbol.toPrimitive](hint){log.push(hint);return "x"}}; var s=`${x}${(log.push("next"),x)}`; module.exports=[s,log];',
    'var log=[]; try{`${Symbol()}${log.push("late")}`}catch(e){log.push(e.name)} module.exports=log;',
    'var x={[Symbol.toPrimitive](){throw new Error("coercion")}}; var log=[]; try{`${x}${log.push("late")}`}catch(e){log.push(e.message)} module.exports=log;',
    'module.exports=`${null}:${undefined}:${1n}:${-0}`;',
  ])('preserves behavior: %s', code => {
    const ast = parse(code);
    applyTemplateLiteralFlattening(ast);
    expect(evaluate(recast.print(ast).code)).toEqual(evaluate(code));
    expect(evaluate(obfuscate(code, { targetTokens: 1, stubConsole: false }))).toEqual(evaluate(code));
  });
});

describe('review: batch merging preserves directives and interpreter', () => {
  it.each(['', '#!/usr/bin/env node\n'])('preserves strict mode with prefix %j', prefix => {
    const code = prefix + '"use strict"; module.exports=(function(){return this===undefined})();';
    const files = obfuscateMultiple([
      { filename: 'a.js', code },
      { filename: 'b.js', code: 'module.exports="sibling";' },
    ], { targetTokens: 1, stubConsole: false });
    expect(evaluate(files[0].code)).toBe(true);
    if (prefix) expect(files[0].code.startsWith(prefix)).toBe(true);
    expect(evaluate(files[1].code)).toBe('sibling');
  });
});

describe('review: batch normalization keeps shebangs before directives', () => {
  it('preserves executable headers when unequal string arrays are padded', () => {
    const prefix = '#!/usr/bin/env node\n';
    const files = obfuscateMultiple([
      { filename: 'a.js', code: prefix + '"use strict"; module.exports=["a", (function(){return this===undefined})()];' },
      { filename: 'b.js', code: prefix + '"use strict"; module.exports=["b", "c", "d", (function(){return this===undefined})()];' },
    ], { targetTokens: 300, stubConsole: false });
    for (const file of files) {
      expect(file.code.startsWith(prefix)).toBe(true);
      const result = evaluate(file.code);
      expect(result[result.length - 1]).toBe(true);
    }
  });
});

describe('review: printing does not rewrite literal contents', () => {
  it.each([
    'module.exports=String.raw`--1 // keep /* keep */`;',
    'module.exports={"--1":"value"};',
    'module.exports=[- -1, -0, -42, -(-3)];',
    'function tag(s){return [s[0],s.raw[0]]} module.exports=tag`--1  two spaces\n// literal`;',
  ])('preserves behavior: %s', code => {
    expect(evaluate(obfuscate(code, { targetTokens: 1, stubConsole: false }))).toEqual(evaluate(code));
  });

  it('rejects syntax unsupported by the output minifier rather than stripping source text', () => {
    expect(() => obfuscate('module.exports=<div title="// keep"/>;', {
      targetTokens: 1, stubConsole: false,
    })).toThrow('Unable to minify obfuscated JavaScript');
  });
});

describe('review: bare returns and top-level RegExp shadowing', () => {
  it.each([
    'var log=[]; function f(){log.push(42); return;} module.exports=[f(),log];',
    'const RegExp=123; module.exports=/a/i.test("A");',
    'let RegExp=123; module.exports=[/a/.test("a"),RegExp];',
    'const RegExp=123, globalThis=null; module.exports=/a/.test("a");',
  ])('preserves behavior: %s', code => {
    for (const targetTokens of [1, 100]) {
      expect(evaluate(obfuscate(code, { targetTokens, stubConsole: false }))).toEqual(evaluate(code));
    }
  });
});

// Issue #40: three valid-JavaScript shapes that obfuscate() broke. Each
// runs over several budgets and repeats, since most transforms are random.
describe('issue #40: obfuscation preserves tagged templates and this-bound keys', () => {
  const BUDGETS = [1, 300, 20000];
  const expectSameBehavior = (code: string) => {
    const expected = evaluate(code);
    for (const targetTokens of BUDGETS) {
      for (let i = 0; i < 2; i++) {
        expect(evaluate(obfuscate(code, { targetTokens, stubConsole: false }))).toEqual(expected);
      }
    }
  };

  it.each([
    // The issue's repro: the final Terser pass printed `o?.tag`x``.
    'function tag(s){return this===o} const o={tag}; module.exports=(o?.tag)`x`;',
    'function tag(s){return [this===o.b, s[0]]} const o={b:{c:tag}}; module.exports=(o?.b.c)`x`;',
    'function tag(s,v){return [this===o, s.raw[0], v]} const o={k:tag}; const k="k"; module.exports=(o?.[k])`x${1}`;',
    'const f=()=>(s)=>s.raw[0]; const o={f}; module.exports=(o?.f())`q`;',
    // Nullish receiver / missing tag still throw after the substitutions run.
    'const o=null; let n=0; try{(o?.tag)`x${n++}`}catch(e){module.exports=[e.name,n]}',
    'const o={}; try{(o?.tag)`x`}catch(e){module.exports=e.name}',
    // Tag, then substitutions, in source order.
    'const order=[]; const o={get t(){order.push("tag"); return (s,v)=>v}}; module.exports=[(o?.t)`${order.push("sub")}`, order];',
  ])('keeps parentheses around an optional-chain tag: %s', code => {
    expectSameBehavior(code);
  });

  it.each([
    // The issue's repro: Terser's tokenizer rejected the raw text.
    'const raw=(s)=>[s.raw[0], s[0]]; module.exports=raw`\\u{`;',
    'const raw=(s)=>[s.raw, s.map(x=>x===undefined)]; module.exports=[raw`\\x`, raw`\\u`, raw`\\01`, raw`\\u{110000}`, raw`a${1}\\u{${2}ok\\n`];',
    'module.exports=[String.raw`\\u{`, String.raw`\\xz${1}\\u12`];',
    'const o={p:"P", t(s){return this.p+s.raw[0]}}; module.exports=[o.t`\\u{`, (o?.t)`\\u{`];',
    'module.exports=((s)=>s.raw[0])`\\u{`;',
    'class A{m(s){return s.raw[0]}} class B extends A{n(){return super.m`\\u{`}} module.exports=new B().n();',
    // The template object keeps its per-site identity and spec shape.
    'const t=(s)=>s; function g(){return t`\\u{`} const a=g(), b=g(); const d=Object.getOwnPropertyDescriptor(a,"raw"); module.exports=[a===b, a===t`\\u{`, Object.isFrozen(a), Object.isFrozen(a.raw), d.enumerable, d.writable, d.configurable, a.length, 0 in a, Array.isArray(a)];',
  ])('minifies tagged templates with invalid escapes: %s', code => {
    expectSameBehavior(code);
  });

  it.each([
    // The issue's repro: `other.tag` was renamed while `this.tag` in the
    // borrowed `hi` kept reading `.tag`.
    'const base={hi(){return this.tag}}; const obj={__proto__:base, tag:"obj", hi(){return super.hi()}}; const other={tag:"other", hi:obj.hi}; module.exports=obj.hi()+" "+other.hi();',
    'function hi(){return this.tag} const other={tag:"other", hi}; module.exports=[other.hi(), (other.hi)(), other?.hi(), other.hi`x`];',
    'const hi=function(){return this.tag}; const other={tag:"other", hi:hi}; module.exports=other.hi();',
    'function make(){return function(){return this.tag}} const other={tag:"other", hi:make()}; module.exports=other.hi();',
    'function hi(){return this.tag} const other={tag:"other", hi:null}; other.hi=hi; module.exports=other.hi();',
    'function hi(){return eval("this.tag")} const other={tag:"other", hi}; module.exports=other.hi();',
    'function hi(){return this.tag} let g=()=>1; g=hi; const other={tag:"other", hi:g}; module.exports=other.hi();',
    'const other={tag:"other"}; other.__defineGetter__("t", function(){return this.tag}); module.exports=other.t;',
  ])('keeps keys that a this-using method can read: %s', code => {
    expectSameBehavior(code);
  });
});

describe('issue #40: tagged template lowering scope', () => {
  it.each([
    ['tag`x${1}\\n`;', 0, true],
    ['o.tag`x`; (o.tag)`y`;', 0, true],
    ['(o?.tag)`x`;', 1, false],
    ['tag`\\u{`; tag`\\x${1}`; (o?.[k])`ok`; tag`fine`;', 3, true],
  ])('lowers only the shapes the minifier cannot print: %s', (code, count, keepsTemplate) => {
    const ast = parse(code as string);
    expect(applyTaggedTemplateLowering(ast)).toBe(count);
    expect(recast.print(ast).code.includes('`')).toBe(keepsTemplate);
  });
});
