import { obfuscate, obfuscateMultiple } from '../obfuscator';
import { computeBloatBudget } from '../options';
import { createContext, runInContext } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const options = (source: string) => ({
  cspSafe: true,
  stubConsole: false,
  targetTokens: Math.ceil(source.length * 30 / 4),
});
function execute(source: string) {
  const timers: (() => void)[] = [];
  const context = createContext({
    setInterval(callback: () => void) { timers.push(callback); return { unref() {} }; },
  }, { codeGeneration: { strings: false, wasm: false } });
  runInContext(source, context, { timeout: 3000 });
  // Exercise the delayed anti-debug helpers as well as program startup.
  for (const callback of timers) callback();
  return { context, timers };
}

describe('CSP-safe profile at ratio 30', () => {
  it('retains structural obfuscation and timers without generated string execution', () => {
    const source = 'function secretComputation(a) { const transformed = a + 2; return Math.max(transformed, 42); } globalThis.result = secretComputation(20);';
    const opts = options(source);
    expect(computeBloatBudget(source.length, opts).maxBloatRatio).toBeGreaterThanOrEqual(30);
    for (let attempt = 0; attempt < 3; attempt++) {
      const out = obfuscate(source, opts);
      expect(out).not.toContain('secretComputation');
      expect(out).not.toMatch(/\beval\b/);
      expect(out).toContain('debugger');
      const { context, timers } = execute(out);
      expect(context.result).toBe(42);
      expect(timers.length).toBeGreaterThanOrEqual(10);
    }
  });

  it('preserves lexical globals, local shadowing, absent-global probes, and updates', () => {
    const source = `
      function shadow(Math) { return Math.max(1, 3); }
      const local = shadow({ max: (a, b) => a + b });
      globalThis.result = [local, Math.max(1, 3), typeof HTMLCanvasElement];
    `;
    const out = obfuscate(source, options(source));
    expect(Array.from(execute(out).context.result)).toEqual([4, 3, 'undefined']);
  });

  it('threads the profile through batch obfuscation', () => {
    const files = [
      { filename: 'one.js', code: 'globalThis.result = Math.max(4, 9);' },
      { filename: 'two.js', code: 'globalThis.result = JSON.stringify([42]);' },
    ];
    const results = obfuscateMultiple(files, { cspSafe: true, stubConsole: false, targetTokens: 400 });
    expect(results.map(result => execute(result.code).context.result)).toEqual([9, '[42]']);
  });

  it('preserves ESM imports, live exports, and module strictness under CSP', () => {
    const source = `import { delta } from 'dependency'; export let value = 1; export function update() { value += delta; return this; }`;
    const output = obfuscate(source, options(source));
    const runner = `
      const vm = require('node:vm');
      const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
      const dependency = new vm.SourceTextModule('export const delta = 2;', { context });
      const app = new vm.SourceTextModule(require('node:fs').readFileSync(0, 'utf8'), { context });
      (async () => {
        await app.link(() => dependency);
        await app.evaluate();
        const update = app.namespace.update;
        if (update() !== undefined || app.namespace.value !== 3) process.exit(1);
      })().catch(error => { console.error(error); process.exit(1); });
    `;
    expect(() => execFileSync(process.execPath, ['--experimental-vm-modules', '-e', runner], {
      input: output, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
    })).not.toThrow();
  });

  it('does not pretend source-provided dynamic evaluation is CSP-safe', () => {
    const source = 'globalThis.result = eval("1 + 1");';
    expect(() => execute(obfuscate(source, options(source)))).toThrow(/Code generation from strings disallowed/);
  });

  it('accepts --csp-safe in the CLI for single and batch inputs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'egodeath-csp-cli-'));
    try {
      const first = join(directory, 'one.js');
      const second = join(directory, 'two.js');
      writeFileSync(first, 'globalThis.result = 42;');
      writeFileSync(second, 'globalThis.result = 43;');
      // Run source CLI through tsx so tests do not depend on a stale dist build.
      const cli = join(__dirname, '../../src/cli.ts');
      const args = ['--import', 'tsx', cli, '--csp-safe', '--no-console-stub', '--target-tokens', '300'];
      const single = execFileSync(process.execPath, [...args, first], { encoding: 'utf8', timeout: 20000 });
      expect(execute(single).context.result).toBe(42);
      execFileSync(process.execPath, [...args, first, second], { stdio: 'pipe', timeout: 20000 });
      expect(execute(readFileSync(join(directory, 'two.obfuscated.js'), 'utf8')).context.result).toBe(43);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
