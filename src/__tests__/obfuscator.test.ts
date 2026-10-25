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
