/**
 * Ambient declaration for the OPTIONAL runtime entrypoint of `@dominevo/server`.
 *
 * `serve` / `agent` boot the server via a side-effect dynamic import of its
 * compiled entry (`@dominevo/server/main.js`). The server is an optional
 * runtime dependency (see package.json `optionalDependencies`) and ships no
 * `.d.ts` for its entrypoint — it's imported only to run, never for its API —
 * so we declare it as an untyped module to keep the dynamic import type-clean.
 */
declare module '@dominevo/server/main.js'

/**
 * The LAUNCHER — what `dominevo serve` / `dominevo agent` import.
 *
 * `main.js` is the hub bootstrap and runs on import, so importing it made
 * `dominevo agent` boot a hub. The launcher reads `CAMSTACK_ROLE` and branches
 * to the right runtime, and wires the framework/NODE_PATH resolution that
 * importing main.js skipped entirely.
 */
declare module '@dominevo/server/launcher.js'
