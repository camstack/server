/**
 * Shared shell types.
 *
 * `NodeRole` is the single desktop app's chosen role. `'hub'` and `'agent'` map
 * 1:1 onto the server closure's `CAMSTACK_ROLE` env marker (see
 * `@camstack/server`'s `resolveNodeRole`) and both SPAWN a node child.
 * `'viewer'` spawns NOTHING: it is a pure client shell whose window loads a
 * REMOTE hub's viewer SPA (`https://<hub>/viewer/camstack/`). The shell
 * persists the role via `electron-store` so ONE signed app can be any of the
 * three.
 */
export type NodeRole = 'hub' | 'agent' | 'viewer'
