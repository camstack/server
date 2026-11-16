/**
 * Groups a camera's events into time clusters: consecutive events no further
 * apart than `gapMs` form one cluster, so a long list reads as "12 events
 * around 14:02" instead of an endless scroll.
 */

export const DEFAULT_CLUSTER_GAP_MS = 2 * 60 * 1000

export interface EventCluster<T> {
  /** Oldest event start in the cluster. */
  readonly fromMs: number
  /** Newest event start in the cluster. */
  readonly toMs: number
  /** Events newest first. */
  readonly events: readonly T[]
}

/** Clusters returned newest first; `gapMs` must be positive. */
export function clusterEvents<T>(
  events: readonly T[],
  startOf: (event: T) => number,
  gapMs: number = DEFAULT_CLUSTER_GAP_MS,
): readonly EventCluster<T>[] {
  const sorted = [...events].sort((a, b) => startOf(b) - startOf(a))
  const clusters: { fromMs: number; toMs: number; events: T[] }[] = []
  for (const event of sorted) {
    const current = clusters[clusters.length - 1]
    const at = startOf(event)
    if (current !== undefined && current.fromMs - at <= gapMs) {
      current.events.push(event)
      current.fromMs = at
    } else {
      clusters.push({ fromMs: at, toMs: at, events: [event] })
    }
  }
  return clusters
}
