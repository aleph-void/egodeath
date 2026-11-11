/**
 * Recast-compatible parser backed by @babel/parser 8.
 *
 * Pass this module as `recast.parse(source, { parser: require('./babelParser') })`
 * instead of `recast/parsers/babel`. Recast's bundled Babel options still
 * enable plugins that Babel 8 removed (`decimal`, `importAssertions`,
 * `recordAndTuple`, and `pipelineOperator` with the "minimal" proposal), and
 * Babel 8 rejects them at parse time. These options mirror recast's — tolerate
 * as much syntax as possible — minus those removed plugins.
 */
import * as babelParser from '@babel/parser';

type RecastParseOptions = { sourceType?: 'module' | 'script'; strictMode?: boolean } | undefined;

export function parse(source: string, options?: RecastParseOptions) {
  return babelParser.parse(source, {
    sourceType: options?.sourceType ?? 'module',
    strictMode: options?.strictMode ?? false,
    allowImportExportEverywhere: true,
    allowReturnOutsideFunction: true,
    startLine: 1,
    tokens: true,
    plugins: [
      'asyncGenerators',
      'bigInt',
      'classPrivateMethods',
      'classPrivateProperties',
      'classProperties',
      'classStaticBlock',
      'decorators-legacy',
      'doExpressions',
      'dynamicImport',
      'exportDefaultFrom',
      'exportExtensions',
      'exportNamespaceFrom',
      'functionBind',
      'functionSent',
      'importMeta',
      'nullishCoalescingOperator',
      'numericSeparator',
      'objectRestSpread',
      'optionalCatchBinding',
      'optionalChaining',
      'throwExpressions',
      'topLevelAwait',
      'v8intrinsic',
      'jsx',
      'flow',
      'decoratorAutoAccessors',
    ] as any,
  });
}
