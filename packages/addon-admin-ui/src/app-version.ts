// Ambient declaration for the Vite-injected build-time version constant
// (see vite.config.ts `define.__APP_VERSION__`). Kept in a `.ts` rather than a
// `.d.ts` because `packages/*/src/**/*.d.ts` is gitignored in this repo, which
// would drop the declaration on a fresh checkout. The real exported type below
// makes this file a module so the `declare global` is allowed; it emits no
// runtime code and avoids a bare `export {}` (which oxlint's
// `unicorn(require-module-specifiers)` flags as an empty export specifier).

declare global {
  /** Admin-UI plugin version from package.json, replaced at build time. */
  const __APP_VERSION__: string
}

/** String type of the build-time-injected app version constant. */
export type AppVersion = typeof __APP_VERSION__
