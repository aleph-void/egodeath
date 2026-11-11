/**
 * Static leakage probes inspired by obfuscation examples. These are not
 * implementations of cryptographic impossibility proofs or a security score.
 * A PASS means only that this particular static probe found no evidence;
 * runtime decoding, data-flow analysis and other attacks may still succeed.
 */

import { obfuscate } from '../obfuscator';
import { inspectSource, hasOperatorSequence, hasByteSequence } from './sourceAnalysis';

// ---- Test result types ----

export interface ExtractionAttempt {
  /** Name of the test case */
  name: string;
  /** Description of what makes this function hard to obfuscate */
  description: string;
  /** The original source code */
  originalCode: string;
  /** The obfuscated output */
  obfuscatedCode: string;
  /** Whether the secret was found in the obfuscated output */
  secretExtracted: boolean;
  /** Details of the extraction attempt */
  extractionDetails: string;
  /** The secret that was embedded */
  secret: string;
  /** Category of the test */
  category: string;
}

// ---- Test case 1: Point function (password check) ----

/**
 * A point function returns true for exactly one input (the "password").
 * Paper 1 shows these CAN be obfuscated (via hashing), but a naive
 * obfuscator that leaves the comparison string visible fails.
 *
 * Tests: Is the password string visible in the obfuscated output?
 */
export function testPointFunction(targetTokens: number = 10000): ExtractionAttempt {
  const secret = 'SuperSecretPassword_' + Math.random().toString(36).slice(2, 10);
  const code = `
    function checkPassword(input) {
      if (input === "${secret}") {
        return true;
      }
      return false;
    }
    module.exports = checkPassword;
  `;

  const obfuscated = obfuscate(code, { targetTokens, stubConsole: false });
  const evidence = inspectSource(obfuscated);

  // Extraction attempt: search for the password string directly
  const directMatch = evidence.strings.some(value => value.includes(secret));
  // Also try partial matches (substrings of 8+ chars)
  const partialMatch = secret.length >= 8 &&
    evidence.strings.some(value => value.includes(secret.substring(0, 8)));

  return {
    name: 'Point Function (Password Check)',
    description: 'Function returns true for exactly one secret input. Tests if the secret string is hidden.',
    category: 'point-function',
    originalCode: code,
    obfuscatedCode: obfuscated,
    secret,
    secretExtracted: directMatch || partialMatch,
    extractionDetails: directMatch
      ? 'FAIL: Password found as literal string in output'
      : partialMatch
        ? 'WEAK: Password prefix found in output'
        : 'PASS: Password absent from parsed literals; runtime decoding was not tested',
  };
}

// ---- Test case 2: Embedded constant / magic number ----

/**
 * A function that uses a distinctive constant (magic number) in
 * its computation. If the constant appears in the obfuscated output,
 * an attacker can identify the algorithm.
 */
export function testMagicNumber(targetTokens: number = 10000): ExtractionAttempt {
  // Use a distinctive constant that would identify the algorithm
  const secret = '3735928559'; // 0xDEADBEEF
  const code = `
    function hash(input) {
      var h = 3735928559;
      for (var i = 0; i < input.length; i++) {
        h = h ^ input.charCodeAt(i);
        h = (h * 16777619) >>> 0;
      }
      return h;
    }
    module.exports = hash;
  `;

  const obfuscated = obfuscate(code, { targetTokens, stubConsole: false });
  const evidence = inspectSource(obfuscated);

  // Search for the magic number in various representations
  const decMatch = evidence.numbers.includes(3735928559);
  const fnvMatch = evidence.numbers.includes(16777619);

  return {
    name: 'Magic Number Extraction',
    description: 'Function uses distinctive constants (0xDEADBEEF, FNV prime). Tests if constants are hidden.',
    category: 'magic-number',
    originalCode: code,
    obfuscatedCode: obfuscated,
    secret,
    secretExtracted: decMatch || fnvMatch,
    extractionDetails: decMatch
      ? 'FAIL: Magic number 0xDEADBEEF recovered from literals or constant expressions'
      : fnvMatch
        ? 'WEAK: FNV prime 16777619 found in output'
        : 'PASS: Magic numbers absent from literals and constant numeric expressions',
  };
}

// ---- Test case 3: Canary string pattern ----

/**
 * Embeds a distinctive string pattern that could identify the
 * software or its version. Tests if identifiable strings survive
 * obfuscation.
 */
export function testCanaryString(targetTokens: number = 10000): ExtractionAttempt {
  const secret = 'MyApp-v2.3.1-licensed-to-user42';
  const code = `
    function getVersion() {
      var version = "${secret}";
      return version;
    }
    module.exports = getVersion;
  `;

  const obfuscated = obfuscate(code, { targetTokens, stubConsole: false });
  const evidence = inspectSource(obfuscated);

  const directMatch = evidence.strings.some(value => value.includes(secret));
  // Try fragments
  const fragmentMatch =
    evidence.strings.some(value => value.includes('MyApp')) ||
    evidence.strings.some(value => value.includes('v2.3.1')) ||
    evidence.strings.some(value => value.includes('licensed')) ||
    evidence.strings.some(value => value.includes('user42'));

  return {
    name: 'Canary String Pattern',
    description: 'Function returns a distinctive version/license string. Tests if identifiable fragments survive.',
    category: 'canary-string',
    originalCode: code,
    obfuscatedCode: obfuscated,
    secret,
    secretExtracted: directMatch || fragmentMatch,
    extractionDetails: directMatch
      ? 'FAIL: Canary string found verbatim in output'
      : fragmentMatch
        ? 'WEAK: Canary string fragments found in output'
        : 'PASS: Canary absent from parsed literals; runtime decoding was not tested',
  };
}

// ---- Test case 4: Embedded key bytes ----

/**
 * A function that uses a cryptographic-style key (sequence of bytes).
 * Tests if byte sequences survive obfuscation.
 */
export function testEmbeddedKey(targetTokens: number = 10000): ExtractionAttempt {
  // Generate a random "key"
  const keyBytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  const secret = keyBytes.join(',');
  const code = `
    function getKey() {
      var key = [${secret}];
      return key;
    }
    module.exports = getKey;
  `;

  const obfuscated = obfuscate(code, { targetTokens, stubConsole: false });
  const evidence = inspectSource(obfuscated);

  // Search for the key bytes as a sequence
  const fullMatch = hasByteSequence(evidence, keyBytes);
  // Try finding 4+ consecutive bytes
  let partialMatch = false;
  for (let i = 0; i <= keyBytes.length - 4; i++) {
    const fragment = keyBytes.slice(i, i + 4);
    if (hasByteSequence(evidence, fragment)) {
      partialMatch = true;
      break;
    }
  }

  return {
    name: 'Embedded Key Bytes',
    description: 'Function returns a 16-byte key array. Tests if byte sequences are hidden.',
    category: 'embedded-key',
    originalCode: code,
    obfuscatedCode: obfuscated,
    secret: `[${secret}]`,
    secretExtracted: fullMatch || partialMatch,
    extractionDetails: fullMatch
      ? 'FAIL: Full key byte sequence found in output'
      : partialMatch
        ? 'WEAK: Partial key sequence (4+ bytes) found in output'
        : 'PASS: Key byte sequence absent from constant numeric arrays',
  };
}

// ---- Test case 5: URL/endpoint leak ----

/**
 * A function that contains an API URL. Tests if URLs survive obfuscation.
 */
export function testUrlLeak(targetTokens: number = 10000): ExtractionAttempt {
  const secret = 'https://api.internal.example.com/v2/secret-endpoint';
  const code = `
    function getEndpoint() {
      var url = "${secret}";
      return url;
    }
    module.exports = getEndpoint;
  `;

  const obfuscated = obfuscate(code, { targetTokens, stubConsole: false });
  const evidence = inspectSource(obfuscated);

  const directMatch = evidence.strings.some(value => value.includes(secret));
  const domainMatch = evidence.strings.some(value => {
    try {
      return new URL(value).hostname === 'api.internal.example.com';
    } catch {
      return value === 'api.internal.example.com';
    }
  });
  const pathMatch = evidence.strings.some(value => value.includes('secret-endpoint'));

  return {
    name: 'URL/Endpoint Leak',
    description: 'Function contains an API URL. Tests if URLs are hidden.',
    category: 'url-leak',
    originalCode: code,
    obfuscatedCode: obfuscated,
    secret,
    secretExtracted: directMatch || domainMatch || pathMatch,
    extractionDetails: directMatch
      ? 'FAIL: Full URL found in output'
      : domainMatch
        ? 'WEAK: Domain name found in output'
        : pathMatch
          ? 'WEAK: URL path found in output'
          : 'PASS: URL absent from parsed literals; runtime decoding was not tested',
  };
}

// ---- Test case 6: Regex pattern leak ----

/**
 * A function that uses a distinctive regex. Tests if regex patterns
 * survive obfuscation (they often do since regex literals are special).
 */
export function testRegexLeak(targetTokens: number = 10000): ExtractionAttempt {
  const secret = '^[A-Z]{2}\\d{6}[A-Z]$';
  const code = `
    function validateID(input) {
      var pattern = new RegExp(${JSON.stringify(secret)});
      return pattern.test(input);
    }
    module.exports = validateID;
  `;

  const obfuscated = obfuscate(code, { targetTokens, stubConsole: false });
  const evidence = inspectSource(obfuscated);

  // Regex patterns are strings, so they should go through string array
  const directMatch = evidence.strings.some(value => value.includes(secret));
  const fragmentMatch = evidence.strings.some(value => value.includes('[A-Z]')) || evidence.strings.some(value => value.includes('\\d{6}'));

  return {
    name: 'Regex Pattern Leak',
    description: 'Function uses a distinctive regex pattern. Tests if regex strings are hidden.',
    category: 'regex-leak',
    originalCode: code,
    obfuscatedCode: obfuscated,
    secret,
    secretExtracted: directMatch || fragmentMatch,
    extractionDetails: directMatch
      ? 'FAIL: Full regex pattern found in output'
      : fragmentMatch
        ? 'WEAK: Regex fragments found in output'
        : 'PASS: Regex absent from parsed literals; runtime decoding was not tested',
  };
}

// ---- Test case 7: Control flow signature ----

/**
 * A function with a distinctive control flow pattern (specific
 * sequence of operations). Tests if the operation sequence is
 * preserved or scrambled by CFF.
 */
export function testControlFlowSignature(targetTokens: number = 10000): ExtractionAttempt {
  const secret = 'add-mul-sub-xor-shift'; // The operation sequence
  const code = `
    function transform(x) {
      var a = x + 42;
      var b = a * 7;
      var c = b - 13;
      var d = c ^ 255;
      var e = d << 3;
      return e;
    }
    module.exports = transform;
  `;

  const obfuscated = obfuscate(code, { targetTokens, stubConsole: false });
  const evidence = inspectSource(obfuscated);

  const inOrder = hasOperatorSequence(evidence, ['+', '*', '-', '^', '<<']);

  return {
    name: 'Control Flow Signature',
    description: 'Function has a distinctive operation sequence (add-mul-sub-xor-shift). Checks lexical operator order, not recovered control flow.',
    category: 'control-flow',
    originalCode: code,
    obfuscatedCode: obfuscated,
    secret,
    secretExtracted: inOrder,
    extractionDetails: inOrder
      ? 'WEAK: Operator subsequence visible within a function or program (lexical AST order)'
      : 'PASS: Static operator subsequence not found; control-flow recovery was not tested',
  };
}

// ---- Runner ----

/**
 * Run all unobfuscatable function tests and return results.
 */
export function runAllTests(targetTokens: number = 10000): ExtractionAttempt[] {
  return [
    testPointFunction(targetTokens),
    testMagicNumber(targetTokens),
    testCanaryString(targetTokens),
    testEmbeddedKey(targetTokens),
    testUrlLeak(targetTokens),
    testRegexLeak(targetTokens),
    testControlFlowSignature(targetTokens),
  ];
}

/**
 * Print a summary of all test results.
 */
export function printSummary(results: ExtractionAttempt[]): string {
  const lines: string[] = ['=== Unobfuscatable Function Tests: static leakage probes ===\n'];

  let passed = 0;
  let failed = 0;
  let weak = 0;

  for (const r of results) {
    const status = r.secretExtracted ? 'EVIDENCE FOUND' : 'NOT FOUND BY STATIC PROBE';
    const icon = r.secretExtracted ? '\u2717' : '\u2713';
    lines.push(`${icon} ${r.name}: ${status}`);
    lines.push(`  ${r.extractionDetails}`);

    if (r.extractionDetails.startsWith('PASS')) passed++;
    else if (r.extractionDetails.startsWith('WEAK')) weak++;
    else failed++;
  }

  lines.push(`\nResults: ${passed} passed, ${weak} weak, ${failed} failed out of ${results.length}`);
  return lines.join('\n');
}
