import { inspectSource, hasOperatorSequence, hasByteSequence } from '../verification/sourceAnalysis';
import { computeFingerprint, generateNullFunction } from '../verification/nullCircuitTest';
import { testRegexLeak, printSummary, ExtractionAttempt } from '../verification/unobfuscatableTests';
import * as vm from 'node:vm';

const operations = ['+', '*', '-', '^', '<<'];

describe('static leakage evidence has positive and negative controls', () => {
  it.each([
    'function f(x){var a=x+42;var b=a*7;var c=b-13;var d=c^255;return d<<3}',
    'function renamed(入力) { const a = 入力 + 42; const b = a * 7; const c = b - 13; const d = c ^ 255; return d << 3; }',
  ])('detects a visible operator sequence regardless of formatting or names', source => {
    expect(hasOperatorSequence(inspectSource(source), operations)).toBe(true);
  });

  it.each([
    'var text="+ * - ^ <<"; /* + * - ^ << */',
    'function f(x){return x+42} function g(x){return x*7-x^255<<3}',
    'function f(x){var a=x<<3;var b=a^255;var c=b-13;var d=c*7;return d+42}',
  ])('does not manufacture a sequence from text or separate scopes', source => {
    expect(hasOperatorSequence(inspectSource(source), operations)).toBe(false);
  });

  it('decodes escaped literals and reads template and regex text', () => {
    const evidence = inspectSource(String.raw`var a="\x73ecret"; var b=\`canary\`; var c=/endpoint/;`.replace(/\\`/g, '`'));
    expect(evidence.strings).toEqual(expect.arrayContaining(['secret', 'canary', 'endpoint']));
    expect(inspectSource('// "secret"\nvar a=1').strings).toEqual([]);
  });

  it('finds numeric constants independent of spelling and folds pure arithmetic', () => {
    const evidence = inspectSource('var a=0xDEADBEEF,b=3.735928559e9,c=(3735928558^1),d=~(-3735928560);');
    expect(evidence.numbers.filter(n => n === 3735928559).length).toBeGreaterThanOrEqual(2);
    expect(evidence.numbers).toContain(3735928558 ^ 1);
    expect(inspectSource('var s="3735928559"; // 3735928559').numbers).toEqual([]);
  });

  it('recovers byte sequences through encoding without crossing array boundaries', () => {
    const evidence = inspectSource('var a=[0x1,1+1,7^4,~(-5)];');
    expect(hasByteSequence(evidence, [1, 2, 3, 4])).toBe(true);
    expect(hasByteSequence(inspectSource('var a=[unknown(),1,2,3,4];'), [1, 2, 3, 4])).toBe(true);
    expect(hasByteSequence(inspectSource('var a=[1,2],b=[3,4];'), [1, 2, 3, 4])).toBe(false);
    expect(hasByteSequence(inspectSource('var a=[1,2,,3,4];'), [1, 2, 3, 4])).toBe(false);
    expect(hasByteSequence(inspectSource('var a=[1,2,unknown(),4];'), [1, 2, 3, 4])).toBe(false);
  });

  it('does not execute source while collecting evidence', () => {
    const evidence = inspectSource('throw new Error("must not run"); var x=(()=>{throw 1})()');
    expect(evidence.strings).toContain('must not run');
  });

  it('regex probe actually tests a digit escape, not a literal d', () => {
    const probe = testRegexLeak(1);
    for (const code of [probe.originalCode, probe.obfuscatedCode]) {
      const context = { module: { exports: undefined as any } };
      vm.runInNewContext(code, context, { timeout: 2000 });
      expect(context.module.exports('AB123456Z')).toBe(true);
      expect(context.module.exports('ABddddddZ')).toBe(false);
    }
  });

  it('does not equate a negative static probe with a hidden secret', () => {
    const result = { name: 'Canary', secretExtracted: false, extractionDetails: 'PASS: static probe only' } as ExtractionAttempt;
    const report = printSummary([result]);
    expect(report).toContain('NOT FOUND BY STATIC PROBE');
    expect(report).not.toContain('HIDDEN');
  });
});

describe('structural metrics measure syntax rather than source text', () => {
  it('counts Unicode-named functions, arrows, methods and lexical declarations', () => {
    const fp = computeFingerprint('function 函数(){}; const x=()=>1; let y={method(){return 2}};');
    expect(fp.functionCount).toBe(3);
    expect(fp.varDeclCount).toBe(2);
  });

  it('ignores fake code and brackets in comments and literals', () => {
    const a = computeFingerprint('var text="plain";');
    const b = computeFingerprint('/* if(x){eval(x);return x+1} */ var text="function f(){if(x){return x+y;}}";');
    for (const key of ['functionCount', 'ifCount', 'returnCount', 'binaryOpCount', 'evalCount', 'avgNestingDepth'] as const) {
      expect(b[key]).toBe(a[key]);
    }
  });

  it('has formatting-independent structural counts', () => {
    const a = computeFingerprint('function 函数(x) { let y = x + 1; if (y) { return y; } }');
    const b = computeFingerprint('function 函数(x){let y=x+1;if(y){return y}}');
    for (const key of ['functionCount', 'varDeclCount', 'ifCount', 'binaryOpCount', 'returnCount', 'avgNestingDepth'] as const) {
      expect(b[key]).toBe(a[key]);
    }
  });

  it('counts only hex strings in actual arrays', () => {
    const fp = computeFingerprint('var x="deadbeef", arr=[\'00ff\', "\\x64eadbeef"];');
    expect(fp.stringArraySize).toBe(2);
  });

  it('produces a runnable null baseline with zero parameters', () => {
    expect(new Function(generateNullFunction('f', 0, 8) + '; return f();')()).toBeUndefined();
  });
});
