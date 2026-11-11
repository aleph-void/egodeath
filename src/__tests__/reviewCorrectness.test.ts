import * as vm from 'node:vm';
import * as recast from 'recast';
import { obfuscate, obfuscateMultiple } from '../obfuscator';
import { applyControlFlowFlattening } from '../transforms/controlFlowFlattening';
import { applyTemplateLiteralFlattening } from '../transforms/templateLiteralFlattening';
import { thirdPassHandlers } from '../passes/thirdPass';

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
