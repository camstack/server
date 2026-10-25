// Ambient declaration for the Vite-injected build-time version constant
// in the server-side addon entry. The frontend build has an equivalent at
// `src/app-version.ts`; this copy covers `tsconfig.server.json` (which only
// includes `src/server/`). `export {}` makes this a module so `declare global`
// is allowed; it emits no runtime code.

declare global {
  /** Admin-UI server addon version from package.json, replaced at build time. */
  const __APP_VERSION__: string
}

export {}
