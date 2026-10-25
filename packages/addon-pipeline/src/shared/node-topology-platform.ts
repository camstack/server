/**
 * ONE topology-entry → platform/arch lookup, shared by the detection pipeline
 * and the audio analyzer so there is a SINGLE OS-truth read path off the
 * cluster topology (`nodes.topology`, the registration self-report — hub-local,
 * always available even before a node's async accelerator probe completes).
 *
 * Both addons live in this package; keeping the lookup here avoids two divergent
 * copies drifting apart. Pure — it takes the already-fetched topology array (not
 * the SDK client) so it is trivially unit-testable and does not couple to the
 * generated api types. Callers compose their own fallback tiers (probe report,
 * `process.platform`) around it.
 */

/** The two topology fields this module reads. The real topology entries carry
 *  many more fields; structural typing lets the full entries flow in. */
export interface TopologyPlatformEntry {
  readonly id: string
  readonly platform?: string
  readonly arch?: string
}

export interface NodePlatformArch {
  readonly platform?: string
  readonly arch?: string
}

/**
 * Pick a node's `{ platform, arch }` from the cluster topology. Returns an empty
 * object when the topology is missing or the node is absent (caller falls back).
 */
export function pickNodePlatformArch(
  topology: readonly TopologyPlatformEntry[] | null | undefined,
  nodeId: string,
): NodePlatformArch {
  const entry = topology?.find((n) => n.id === nodeId)
  if (!entry) return {}
  return { platform: entry.platform, arch: entry.arch }
}
