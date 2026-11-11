import {
  testPointFunction,
  testMagicNumber,
  testCanaryString,
  testEmbeddedKey,
  testUrlLeak,
  testRegexLeak,
  testControlFlowSignature,
  runAllTests,
  printSummary,
} from '../verification/unobfuscatableTests';

describe('point function (password check)', () => {
  it('hides the password string from the output', () => {
    const result = testPointFunction(10000);
    expect(result.secretExtracted).toBe(false);
    expect(result.extractionDetails).toContain('PASS');
  });

  it('result has all required fields', () => {
    const result = testPointFunction(10000);
    expect(result.name).toBeTruthy();
    expect(result.description).toBeTruthy();
    expect(result.originalCode).toBeTruthy();
    expect(result.obfuscatedCode).toBeTruthy();
    expect(result.secret).toBeTruthy();
    expect(result.category).toBe('point-function');
  });
});

describe('magic number extraction', () => {
  it('reports the exposed magic number rather than accepting any result', () => {
    const result = testMagicNumber(1);
    expect(result.secretExtracted).toBe(true);
    expect(result.extractionDetails).toContain('FAIL');
  });
});

describe('canary string pattern', () => {
  it('hides identifiable string fragments', () => {
    const result = testCanaryString(10000);
    expect(result.secretExtracted).toBe(false);
    expect(result.extractionDetails).toContain('PASS');
  });
});

describe('embedded key bytes', () => {
  it('recovers byte arrays through constant numeric expressions', () => {
    const result = testEmbeddedKey(10000);
    expect(result.secretExtracted).toBe(true);
    expect(result.extractionDetails).toContain('FAIL');
  });
});

describe('URL/endpoint leak', () => {
  it('hides URLs from the output', () => {
    const result = testUrlLeak(10000);
    expect(result.secretExtracted).toBe(false);
    expect(result.extractionDetails).toContain('PASS');
  });
});

describe('regex pattern leak', () => {
  it('hides regex patterns from the output', () => {
    const result = testRegexLeak(10000);
    expect(result.secretExtracted).toBe(false);
    expect(result.extractionDetails).toContain('PASS');
  });
});

describe('control flow signature', () => {
  it('detects the operation sequence when the budget disables CFF', () => {
    const result = testControlFlowSignature(1);
    expect(result.secretExtracted).toBe(true);
    expect(result.extractionDetails).toContain('WEAK');
  });
});

describe('runAllTests', () => {
  it('runs all 7 test cases', () => {
    const results = runAllTests(10000);
    expect(results).toHaveLength(7);
  });

  it('each result has a category', () => {
    const results = runAllTests(10000);
    const categories = results.map(r => r.category);
    expect(categories).toContain('point-function');
    expect(categories).toContain('magic-number');
    expect(categories).toContain('canary-string');
    expect(categories).toContain('embedded-key');
    expect(categories).toContain('url-leak');
    expect(categories).toContain('regex-leak');
    expect(categories).toContain('control-flow');
  });


});

describe('printSummary', () => {
  it('produces readable output', () => {
    const results = runAllTests(10000);
    const summary = printSummary(results);
    expect(summary).toContain('Unobfuscatable Function Tests');
    expect(summary).toContain('Results:');
    expect(summary.length).toBeGreaterThan(100);
  });
});
