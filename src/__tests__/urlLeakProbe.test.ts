import { obfuscate } from '../obfuscator';
import { testUrlLeak } from '../verification/unobfuscatableTests';

// Supply controlled generated output to test the detector, independently of
// the obfuscator's random choice of encodings. No fixture code is executed.
jest.mock('../obfuscator', () => ({ obfuscate: jest.fn() }));
const mockedObfuscate = jest.mocked(obfuscate);

describe('URL leak probe is text detection, not URL authorization', () => {
  it.each([
    ['https://api.internal.example.com/v2/secret-endpoint', 'Full URL'],
    ['debug: https://api.internal.example.com/v2/secret-endpoint (copied)', 'Full URL'],
    ['https://other.invalid/?next=https://api.internal.example.com/v2/secret-endpoint', 'Full URL'],
    ['https://api.internal.example.com.other.invalid/', 'Domain name'],
    ['debug: api.internal.example.com (copied)', 'Domain name'],
    ['secret-endpoint', 'URL path'],
  ])('reports leaked text in %s', (literal, detail) => {
    mockedObfuscate.mockReturnValue(`var text=${JSON.stringify(literal)};`);
    const result = testUrlLeak(1);
    expect(result.secretExtracted).toBe(true);
    expect(result.extractionDetails).toContain(detail);
  });

  it('does not report unrelated URLs', () => {
    mockedObfuscate.mockReturnValue('var text="https://other.invalid/public";');
    const result = testUrlLeak(1);
    expect(result.secretExtracted).toBe(false);
    expect(result.extractionDetails).toContain('PASS');
  });
});
