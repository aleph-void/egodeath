module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  // Force exit after tests complete — anti-debug setInterval traps in
  // obfuscated output keep worker processes alive otherwise.
  forceExit: true,
  // Longer timeout for tests that run the full obfuscation pipeline
  testTimeout: 60000,
  // Limit workers to avoid memory pressure from heavy obfuscation tests
  maxWorkers: 2,
  // Recycle workers between suites so generated code, timers, and compiler
  // state cannot accumulate until Node's heap is exhausted on CI runners.
  workerIdleMemoryLimit: '512MB',
  // SWC transpiles TypeScript 7 tests and jsdom's ESM dependencies for Jest.
  // Type checking remains a separate compiler check in CI.
  transform: {
    '^.+\\.tsx?$': ['@swc/jest', {
      jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
      module: { type: 'commonjs' },
    }],
    '^.+\\.(js|mjs|cjs)$': ['@swc/jest', {
      jsc: { parser: { syntax: 'ecmascript' }, target: 'es2022' },
      module: { type: 'commonjs' },
    }],
  },
  // Transform only the ESM-only packages pulled in by jsdom and @babel/parser
  // (Babel 8 ships ESM only); leave other packages on Jest's default path.
  // Revisit this list when upgrading either if Jest reports an untransformed
  // ESM import.
  transformIgnorePatterns: [
    `/node_modules/(?!(?:${[
      '@asamuzakjp/css-color',
      '@babel/helper-string-parser',
      '@babel/helper-validator-identifier',
      '@babel/parser',
      '@babel/types',
      '@asamuzakjp/dom-selector',
      '@bramus/specificity',
      '@csstools/color-helpers',
      '@csstools/css-calc',
      '@csstools/css-color-parser',
      '@csstools/css-parser-algorithms',
      '@csstools/css-tokenizer',
      '@exodus/bytes',
      'bcp-47',
      'bcp-47-match',
      'css-tree',
      'entities',
      'is-alphabetical',
      'is-alphanumerical',
      'is-decimal',
      'lru-cache',
      'parse5',
      'parse5-parser-stream',
      'tough-cookie',
    ].join('|')})/)`,
  ],
};
