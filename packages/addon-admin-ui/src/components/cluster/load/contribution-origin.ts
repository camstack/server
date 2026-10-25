/**
 * Which NODE a reported load contribution came from.
 *
 * ## Why this is needed at all
 *
 * `system.getLoadContributions` is answered by the hub and returns the WHOLE
 * cluster: `buildLoadContributionPlane` enumerates
 * `registry.getCollectionEntries('load-contribution')`, and that registry holds
 * an entry for every provider the hub knows about — hub-local ones and the RPC
 * proxies it built for remote agents alike.
 *
 * Every number on this surface that involves a `pid` is therefore only
 * meaningful once the set has been narrowed to one node. A pid is unique within
 * a node and nowhere else: `pid 100` on the hub and `pid 100` on an agent are
 * two unrelated processes. Subtracting a cluster-wide claim set from ONE node's
 * process snapshot would mark that node's unclaimed process as claimed because
 * some other machine happens to run a process with the same number — which is
 * exactly the "a process nobody knows about" finding this surface exists to
 * produce, silently deleted.
 *
 * ## Where the node comes from
 *
 * From the registry KEY, which the plane reports verbatim as `addonId`. The
 * rule is stated in `moleculer.service.ts` and mirrored in
 * `CapabilityRegistry.nodeOfKey`:
 *
 * - a hub-local provider (in-process or a forked child) registers under a BARE
 *   `addonId`;
 * - a remote agent's provider registers under `` `${addonId}@${nodeId}` ``.
 *
 * So a bare key means "the hub", and that is the one piece of information that
 * cannot be read off the entry itself. This module does not invent it — it
 * reads the same key the registry writes, with the same `indexOf('@')` split,
 * because a second convention that disagreed with the registry's would
 * attribute a whole agent to the hub without failing anything.
 */
import type { CameraLoadEntry } from './camera-load-fold'

/** A provider key, taken apart. `nodeId: null` means the hub. */
export interface ContributionOrigin {
  /** The bare addon id, as the addon calls itself. */
  readonly addonId: string
  /** The agent this provider registered from, or `null` for a hub-local one. */
  readonly nodeId: string | null
}

/** The node a panel is showing. `isHub` is what a bare key resolves to. */
export interface NodeScope {
  readonly nodeId: string
  readonly isHub: boolean
}

/**
 * Split a registry key into its addon and its node.
 *
 * Deliberately `indexOf`, not `lastIndexOf`: it is the same split
 * `CapabilityRegistry.bareAddonId` / `nodeOfKey` perform, and two functions
 * that split the same key differently is how one provider ends up counted on
 * two nodes.
 */
export function splitProviderKey(providerKey: string): ContributionOrigin {
  const at = providerKey.indexOf('@')
  if (at === -1) return { addonId: providerKey, nodeId: null }
  return { addonId: providerKey.slice(0, at), nodeId: providerKey.slice(at + 1) }
}

/** Did this provider key register from `scope`? */
export function isFromNode(providerKey: string, scope: NodeScope): boolean {
  const origin = splitProviderKey(providerKey)
  return origin.nodeId === null ? scope.isHub : origin.nodeId === scope.nodeId
}

/**
 * Narrow a cluster-wide contribution list to one node.
 *
 * Everything downstream — the per-camera fold, the unclaimed bucket, the claim
 * coverage pair — is pid arithmetic against ONE node's process snapshot, and
 * none of it is true before this call.
 */
export function contributionsOnNode(
  entries: readonly CameraLoadEntry[],
  scope: NodeScope,
): readonly CameraLoadEntry[] {
  return entries.filter((entry) => isFromNode(entry.addonId, scope))
}

/** The bare addon id for display — `recorder`, not `recorder@agent-a`. */
export function bareAddonId(providerKey: string): string {
  return splitProviderKey(providerKey).addonId
}
