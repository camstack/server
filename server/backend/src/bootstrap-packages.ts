/**
 * Hub bootstrap package selection.
 *
 * Extracted from `launcher.ts` so it can be unit-tested: the launcher
 * self-executes `launch()` at import time, so nothing inside it is reachable
 * from a spec. Same shape as `framework-nodepath.ts`.
 *
 * The selection MUST stay in lockstep with
 * `AddonInstaller.deriveBootstrapList` in `@camstack/system` — that one reads
 * the same `@camstack/server` manifest through `require.resolve`, this one
 * reads the launcher's own `package.json` by absolute path (the slim image
 * strips the `@camstack/*` symlinks, so `require.resolve` yields an empty list
 * at launcher import time). Two derivations of the same list is exactly how
 * `@camstack/addon-agent-ui` ended up installed on the hub: the installer's
 * copy honoured `camstack.agentOnlyBootstrapAddons`, this one did not, and the
 * hub is the side that actually boots through here.
 */

/** The subset of `@camstack/server`'s `package.json` this module reads. */
export interface ServerBootstrapManifest {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly camstack?: {
    readonly agentOnlyBootstrapAddons?: readonly string[]
  }
}

/**
 * The packages a HUB-role node bootstrap-installs: every `@camstack/addon-*`
 * runtime dependency plus `@camstack/system` (the carrier of the required
 * infrastructure builtins — storage-provider / settings / logging — without
 * which boot aborts).
 *
 * `camstack.agentOnlyBootstrapAddons` is subtracted. Those addons are declared
 * as runtime dependencies so the published `@camstack/server` closure CARRIES
 * them for agent-role nodes to seed, but they are `execution.placement:
 * 'agent-only'` and the hub must never install them.
 */
export function selectHubBootstrapPackages(pkg: ServerBootstrapManifest): readonly string[] {
  const agentOnly = new Set(pkg.camstack?.agentOnlyBootstrapAddons ?? [])
  return Object.keys(pkg.dependencies ?? {}).filter(
    (name) =>
      !agentOnly.has(name) && (name.startsWith('@camstack/addon-') || name === '@camstack/system'),
  )
}
