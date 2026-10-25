/**
 * Which cluster reads the synthetic node rows (Task D2/D3) may make, and how
 * ONE answer is attributed to many nodes.
 *
 * `recording` is a SINGLETON cap: the recorder runs on one node and boots
 * inert everywhere else ("recorder INERT on this node — recording assigned
 * elsewhere"). A read pinned to an inert node is a question the node cannot
 * answer by construction, and fanning it out per node cost 685 warnings a day
 * on the live hub and never produced a value. One UNPINNED read answers for
 * the cluster and names the node it ran on; every other node is unread — not
 * failed — and its footage rows stay `unknown`.
 *
 * Package status is per node by nature, but an OFFLINE node cannot be asked
 * (a ghost `hub-test` row produced 130 warnings a day) and the hub carries
 * its own `server_version` / `update_available` rows already.
 */

export interface StorageLocationUsage {
  readonly totalBytes: number | null
  readonly availableBytes: number | null
}

export interface StorageUsageAnswer {
  /** The node the singleton recorder actually answered from. */
  readonly nodeId: string
  readonly totalUsedBytes: number
  readonly locations?: readonly StorageLocationUsage[] | undefined
}

export interface NodeFootage {
  readonly footageUsedBytes: number | null
  /** Percent free on the location with the LEAST free space, or `null` = unread. */
  readonly footageFreePercent: number | null
}

const UNREAD: NodeFootage = { footageUsedBytes: null, footageFreePercent: null }

export function footageForNode(nodeId: string, usage: StorageUsageAnswer | null): NodeFootage {
  if (usage === null || usage.nodeId !== nodeId) return UNREAD
  // The location with the LEAST free space is the one an operator's
  // "disk over 90%" alert has to fire on — the healthiest disk cannot hide a
  // full one.
  const freePercents = (usage.locations ?? [])
    .filter(
      (loc): loc is StorageLocationUsage & { availableBytes: number; totalBytes: number } =>
        loc.availableBytes !== null && loc.totalBytes !== null && loc.totalBytes > 0,
    )
    .map((loc) => (loc.availableBytes / loc.totalBytes) * 100)
  return {
    footageUsedBytes: usage.totalUsedBytes,
    footageFreePercent: freePercents.length > 0 ? Math.min(...freePercents) : null,
  }
}

export interface NodeReadTarget {
  readonly isHub: boolean
  readonly isOnline: boolean
}

export function shouldReadPackageStatus(node: NodeReadTarget): boolean {
  return !node.isHub && node.isOnline
}
