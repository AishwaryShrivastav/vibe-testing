/**
 * Frontend/app source files worth returning as context: TypeScript and
 * JavaScript in every module flavour (ESM .mjs/.mts, CommonJS .cjs/.cts),
 * plus Vue and Svelte single-file components.
 *
 * TypeScript declaration files (.d.ts, .d.mts, .d.cts) are excluded: they hold
 * only type signatures — no routes, forms or selectors — and would use up the
 * get_context size budget that real source files need.
 */
export const SOURCE_FILE_PATTERN = /\.(tsx?|jsx?|mts|cts|mjs|cjs|vue|svelte)$/

export function isSourceFile(fileName: string): boolean {
  return SOURCE_FILE_PATTERN.test(fileName) && !/\.d\.[mc]?ts$/.test(fileName)
}
