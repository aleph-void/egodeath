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
  // Transform only jsdom's ESM dependencies; leave other packages on Jest's
  // default path. Revisit this list when upgrading jsdom if Jest reports an
  // untransformed ESM import.
  transformIgnorePatterns: [
    `/node_modules/(?!(?:${[
      '@asamuzakjp/css-color',
      '@asamuzakjp/dom-selector',
      '@bramus/specificity',
      '@csstools/color-helpers',
      '@csstools/css-calc',
      '@csstools/css-color-parser',
      '@csstools/css-parser-algorithms',
      '@csstools/css-tokenizer',
      '@exodus/bytes',
      'css-tree',
      'entities',
      'parse5',
      'tough-cookie',
    ].join('|')})/)`,
  ],
};
