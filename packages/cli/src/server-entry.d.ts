/**
 * Ambient declaration for the OPTIONAL runtime entrypoint of `@camstack/server`.
 *
 * `serve` / `agent` boot the server via a side-effect dynamic import of its
 * compiled entry (`@camstack/server/main.js`). The server is an optional
 * runtime dependency (see package.json `optionalDependencies`) and ships no
 * `.d.ts` for its entrypoint — it's imported only to run, never for its API —
 * so we declare it as an untyped module to keep the dynamic import type-clean.
 */
declare module '@camstack/server/main.js'

/**
 * The LAUNCHER — what `camstack serve` / `camstack agent` import.
 *
 * `main.js` is the hub bootstrap and runs on import, so importing it made
 * `camstack agent` boot a hub. The launcher reads `CAMSTACK_ROLE` and branches
 * to the right runtime, and wires the framework/NODE_PATH resolution that
 * importing main.js skipped entirely.
 */
declare module '@camstack/server/launcher.js'
