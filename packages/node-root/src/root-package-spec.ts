/**
 * Root-package spec — the per-node parameters of the shared node-root boot
 * machinery. Everything else (the `server-root/` data-dir layout, the
 * `state.json` schema, the single-copy boot plan, the update service) is
 * IDENTICAL across nodes; only the root package's name and its loadable entry
 * differ.
 *
 * Post-consolidation there is a SINGLE root package — `@camstack/server` —
 * for every node role. An agent node boots the same `@camstack/server`
 * closure via `CAMSTACK_ROLE=agent`; the launcher branches into the agent
 * runtime at boot. The spec is kept as a parameter (clean DI: the machinery
 * never hard-codes a package name) even though only one spec exists today.
 *
 * Spec: docs/superpowers/specs/2026-07-12-runtime-updatable-node-packages-design.md
 */

export interface RootPackageSpec {
  /** The npm name of the node's root package. */
  readonly packageName: string
  /**
   * Path segments of the loadable entry INSIDE the root package dir
   * (`node_modules/<packageName>/<...entryRelPath>`).
   */
  readonly entryRelPath: readonly string[]
}

/**
 * The single root package for every node role — the starter loads its
 * launcher, which branches on `CAMSTACK_ROLE` into the hub or agent runtime.
 */
export const HUB_ROOT_SPEC: RootPackageSpec = {
  packageName: '@camstack/server',
  entryRelPath: ['dist', 'launcher.js'],
}
