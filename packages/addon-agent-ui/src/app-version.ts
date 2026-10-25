// Ambient declaration for the Vite-injected build-time version constant
// (see vite.lib.config.ts `define.__APP_VERSION__`). Kept in a `.ts` rather than a
// `.d.ts` because `packages/*/src/**/*.d.ts` is gitignored in this repo, which
// would drop the declaration on a fresh checkout. The real type export below
// makes this file a module so `declare global` is allowed; it emits no runtime
// code (a bare `export {}` is flagged by the lint module-specifier rule, so a
// concrete type export is used instead).

declare global {
  /** Agent-UI plugin version from package.json, replaced at build time. */
  const __APP_VERSION__: string
}

export type AppVersion = typeof __APP_VERSION__
