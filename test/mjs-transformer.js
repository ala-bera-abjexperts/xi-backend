/**
 * @fileoverview Jest transformer for `.mjs` files in the dependency closure.
 * @module test/mjs-transformer
 *
 * Why this exists, and why ts-jest alone cannot do it:
 *
 * `sanitize-rich-text.ts` constructs a real jsdom `Window` at module load, so every spec that
 * transitively imports it pulls in jsdom's dependency closure. Parts of that closure are
 * ESM-only — `@csstools/css-tokenizer` ships nothing but `dist/index.mjs` and declares a single
 * `"default"` export condition, so there is no CommonJS build for jest to resolve instead.
 *
 * ts-jest handles the closure's `.js` files once `allowJs` is on (see tsconfig.spec.json), but it
 * cannot handle `.mjs`: TypeScript derives a file's module format from the `.mjs` extension itself
 * and will not emit CommonJS for it, whatever `module` is set to. The ESM `export {...}` therefore
 * survives transpilation and reaches V8 as "SyntaxError: Unexpected token 'export'".
 *
 * Transpiling the same source under a `.js` filename removes that extension-derived override and
 * lets `module: CommonJS` apply, which is all this transformer does.
 *
 * @author Prince Jadiya
 */

const crypto = require('crypto');
const ts = require('typescript');

/** Bump when the emit below changes, so stale jest cache entries are invalidated. */
const CACHE_VERSION = 'mjs-transformer-v1';

const COMPILER_OPTIONS = {
  allowJs: true,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  isolatedModules: true,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  sourceMap: false,
  target: ts.ScriptTarget.ES2023,
};

module.exports = {
  canInstrument: false,

  getCacheKey(sourceText, sourcePath, transformOptions) {
    return crypto
      .createHash('sha256')
      .update(CACHE_VERSION)
      .update('\0')
      .update(sourcePath)
      .update('\0')
      .update(sourceText)
      .update('\0')
      .update(String(transformOptions && transformOptions.instrument))
      .digest('hex');
  },

  process(sourceText, sourcePath) {
    const { outputText } = ts.transpileModule(sourceText, {
      compilerOptions: COMPILER_OPTIONS,
      // The rename is the whole point: `.mjs` forces ESM emit, `.js` does not.
      fileName: sourcePath.replace(/\.mjs$/, '.js'),
    });

    return { code: outputText };
  },
};
