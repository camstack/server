/**
 * The two hooks through which a UI reads the cluster (D311, D317).
 *
 * `nodes.topology` draws the cluster DIAGRAM: every node, every addon, every
 * runner subprocess with its live cpu/rss. Its handler walks the whole fleet,
 * so its cost scales with nodes x processes — measured on the production hub on
 * 2026-08-31 at **30.5 s** while the settings store was stalled. It is the
 * right call for a page that renders that diagram and the wrong call for
 * everything else, and until D317 fourteen call sites made it on mount.
 *
 * Both hooks have the same shape and it is the only shape allowed here:
 * **bootstrap once, then live off the pushed snapshot.** The hub's
 * `TopologyEmitterService` recomputes and emits `cluster.topology-snapshot`
 * every 30 s and, debounced 200 ms, on every agent/addon lifecycle edge — so a
 * subscriber that mounts mid-stream gets its FIRST value from the bootstrap
 * query (that is what the query is for) and every value after it from the push.
 * `staleTime: Infinity` is therefore correct rather than lazy: nothing goes
 * stale, because the owner sends the next one.
 *
 * - {@link useClusterTopology} — the whole diagram. Reach for it only if you
 *   render per-node processes, per-addon status or the balancer graph.
 * - {@link useClusterNodes} — the node ROSTER (id, name, online, addon caps),
 *   which is what a picker, a filter or an "is this node up" check needs.
 *
 * `scripts/check-topology-is-a-diagram-not-a-lookup.ts` keeps every other call
 * site out of `nodes.topology`.
 */
import type { TopologyNode } from '@camstack/types'
import { useMemo } from 'react'
import { trpc } from '../trpc-react'
import { useEventStreamLatest } from './use-event-stream'

export interface ClusterNode {
  readonly id: string
  readonly name: string
  /** Compact label for pill bars: "HUB" for the hub, agent name for agents. */
  readonly shortName: string
  readonly isHub: boolean
  readonly isOnline: boolean
  readonly localIps: readonly string[]
  readonly addons: readonly { readonly addonId: string; readonly capabilities: readonly string[] }[]
}

/** The row shape `nodes.topology` and `cluster.topology-snapshot` both carry. */
export type ClusterTopologyNode = TopologyNode

export interface ClusterTopologyResult {
  /** Every node in the cluster, live or persisted-offline. `undefined` until the first answer. */
  readonly nodes: readonly ClusterTopologyNode[] | undefined
  readonly isLoading: boolean
  readonly isError: boolean
}

/**
 * The whole cluster diagram: bootstrap query, then the pushed snapshot.
 *
 * The ONLY sanctioned reader of `nodes.topology` in a UI. Use it when the
 * component renders something that genuinely needs the diagram — per-node
 * processes, per-addon health, the balancer graph. If you need a node list,
 * use {@link useClusterNodes} instead; if you need one node's addons, ask
 * `nodes.getNodeAddons`, which is one node and does not walk the fleet.
 */
export function useClusterTopology(): ClusterTopologyResult {
  const {
    data: bootstrapTopology,
    dataUpdatedAt,
    isLoading,
    isError,
    // Events are the source of truth — the query exists to give a late joiner
    // its FIRST value, never to poll for the next one.
  } = trpc.nodes.topology.useQuery(undefined, { staleTime: Number.POSITIVE_INFINITY })

  const snapshot = useEventStreamLatest<{
    nodes: readonly TopologyNode[]
    timestamp: number
  }>('cluster.topology-snapshot')

  // When THIS client received the snapshot, on the same clock as
  // `dataUpdatedAt`. A snapshot used to win unconditionally, so a rename (which
  // invalidates the query and refetches a fresher answer, while no snapshot is
  // pushed until the next heartbeat) kept showing the old name until a reload.
  // The newer of the two answers wins; the next pushed snapshot is newer again.
  const snapshotReceivedAt = useMemo(() => (snapshot === null ? 0 : Date.now()), [snapshot])
  const queryIsNewer = bootstrapTopology !== undefined && dataUpdatedAt > snapshotReceivedAt

  const nodes =
    snapshot !== null && !queryIsNewer
      ? snapshot.nodes
      : (bootstrapTopology as readonly TopologyNode[] | undefined)
  return { nodes, isLoading, isError }
}

export function useClusterNodes(): {
  readonly nodes: readonly ClusterNode[]
  readonly isLoading: boolean
  readonly isError: boolean
} {
  const { nodes: sourceNodes, isLoading, isError } = useClusterTopology()

  const nodes = useMemo<readonly ClusterNode[]>(() => {
    const list: ClusterNode[] = []
    for (const n of sourceNodes ?? []) {
      list.push({
        id: String(n.id ?? ''),
        name: String(n.name ?? n.id ?? ''),
        shortName: n.isHub ? 'HUB' : String(n.name ?? n.id ?? ''),
        isHub: Boolean(n.isHub),
        isOnline: Boolean(n.isOnline),
        localIps: (n.localIps ?? []) as string[],
        addons: (n.addons ?? []).map((a) => ({ addonId: a.id, capabilities: a.capabilities })),
      })
    }
    list.sort((a, b) => {
      if (a.isHub !== b.isHub) return a.isHub ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return list
  }, [sourceNodes])

  return { nodes, isLoading, isError }
}
