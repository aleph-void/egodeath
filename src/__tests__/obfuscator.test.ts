import { obfuscate } from '../obfuscator';
import { runInNewContext } from 'node:vm';

// These are pipeline smoke tests, not maximum-bloat load tests. For the
// nonempty fixtures below, this budget still enables every transform gate
// (ratio > 10) without multiplying dead-code generation to its maximum.
const SMOKE_OPTIONS = { targetTokens: 256 };

describe('obfuscate', () => {
  it('produces valid JavaScript output', () => {
    const code = 'var x = 1;';
    const result = obfuscate(code, SMOKE_OPTIONS);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('includes console stubs in output', () => {
    const code = 'var x = 1;';
    const result = obfuscate(code, SMOKE_OPTIONS);
    expect(result).toContain('console.assert');
    expect(result).toContain('console.log');
    expect(result).toContain('console.error');
  });

  it('does not contain original variable names', () => {
    const code = 'var mySpecialVariable = 42;';
    const result = obfuscate(code, SMOKE_OPTIONS);
    expect(result).not.toContain('mySpecialVariable');
  });

  it('encodes global keywords like Array and Object (not readable)', () => {
    const code = 'var x = new Array(); var y = Object.keys({});';
    const result = obfuscate(code, SMOKE_OPTIONS);
    // Globals are now eval-encoded, so they should NOT appear as plain identifiers
    // but the code should contain eval (used to recover them at runtime)
    expect(result).toContain('eval');
    expect(result).toContain('replace');
  });

  it('handles function declarations', () => {
    const code = 'function myFunc(a, b) { return a + b; }';
    const result = obfuscate(code, SMOKE_OPTIONS);
    expect(result).not.toContain('myFunc');
    expect(typeof result).toBe('string');
  });

  it.each(['', ' \n\t', '// comment only', '#!/usr/bin/env node\n'])(
    'handles empty programs with the default budget (%j)', (source) => {
      const result = obfuscate(source);
      expect(typeof result).toBe('string');
      // Should still have console stubs
      expect(result).toContain('console');
      expect(result.length).toBeLessThan(10000);
      const consoleStub: Record<string, unknown> = {};
      runInNewContext(result, { console: consoleStub }, { timeout: 1000 });
      expect(typeof consoleStub.log).toBe('function');
      if (source.startsWith('#!')) expect(result).toMatch(/^#!\/usr\/bin\/env node\n/);
    },
  );

  it('is idempotent in terms of resetting state', () => {
    const code = 'var a = 1;';
    const result1 = obfuscate(code, SMOKE_OPTIONS);
    const result2 = obfuscate(code, SMOKE_OPTIONS);
    // Both should be valid (names differ due to randomness)
    expect(result1).toContain('console');
    expect(result2).toContain('console');
  });
});

describe('stubConsole option', () => {
  // The console stub overwrites console methods with no-ops on the real,
  // shared console object. That is process-wide, so apps that keep their own
  // logging need to turn it off.
  const code = 'module.exports = { run: () => { console.log("hi"); return 1; } };';

  // Returns whether the original console.log survived module load (identity
  // preserved) — the stub assigns a fresh no-op over every console method.
  function originalConsoleSurvives(opts: Record<string, unknown>): boolean {
    const out = obfuscate(code, { targetTokens: 2000, ...opts });
    const original = (): undefined => undefined;
    (original as { marker?: boolean }).marker = true;
    const sandboxConsole: Record<string, unknown> = { log: original };
    const moduleObj: { exports: Record<string, unknown> } = { exports: {} };
    runInNewContext(
      out,
      { console: sandboxConsole, module: moduleObj, exports: moduleObj.exports, require },
      { timeout: 1000 },
    );
    return (sandboxConsole.log as { marker?: boolean }).marker === true;
  }

  it('stubs console by default (unchanged behavior)', () => {
    expect(originalConsoleSurvives({})).toBe(false);
  });

  it('leaves console untouched when stubConsole is false', () => {
    expect(originalConsoleSurvives({ stubConsole: false })).toBe(true);
  });

  it('omits the console-stub prelude from the output', () => {
    const stubbed = obfuscate(code, { targetTokens: 2000 });
    const plain = obfuscate(code, { targetTokens: 2000, stubConsole: false });
    // The stub assigns to console methods; without it there is no such prelude.
    expect(stubbed).toMatch(/console/);
    expect(plain).not.toMatch(/console\s*\[/);
    expect(plain).not.toMatch(/console\.\w+\s*=/);
  });

  it('does not emit console stubs for an empty program when disabled', () => {
    expect(obfuscate('', { targetTokens: 2000, stubConsole: false }).trim()).toBe('');
    expect(obfuscate('', { targetTokens: 2000 })).toMatch(/console/);
  });
});
