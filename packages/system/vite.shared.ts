/**
 * Externals shared by BOTH `@camstack/system` builds (`vite.config.ts` and
 * `vite.runner.config.ts`) — one list, so the runner can never drift from the hub.
 */
export const SYSTEM_EXTRA_EXTERNALS: readonly (string | RegExp)[] = [
  'ws',
  'bufferutil',
  'utf-8-validate',
  '@trpc/server',
  // winston + transitive deps (moment via file-stream-rotator) must
  // stay as runtime `require()` calls — bundling them rewrites the
  // CJS imports and breaks `moment()`-as-function downstream.
  'winston',
  'winston-transport',
  'winston-daily-rotate-file',
  'file-stream-rotator',
  'moment',
  'triple-beam',
  'object-hash',
  /**
   * esbuild REFUSES to run when it has been bundled, and it is right to.
   *
   * Its JS API locates a native binary by a relative path from its own
   * module file; inlined into `dist/main-*.js` that path resolves to
   * nothing, so `transform()` throws
   * *"The esbuild JavaScript API cannot be bundled"* — the compile gate in
   * `builtins/core-blocks` then refuses every write.
   *
   * Found on the live hub 2026-08-08, from the error naming this exact
   * bundle: **no core block could be created there, ever**. That is what
   * "shipped 2026-08-05, zero adoption" actually measured. `loadTranspiler`
   * catches the IMPORT failing, not the API refusing, so the only symptom
   * was a save that came back with a compile error nobody could fix.
   */
  'esbuild',
]
