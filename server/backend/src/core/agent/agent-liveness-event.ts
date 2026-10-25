import type { EventCatalog } from '@camstack/types'
import type { PersistedClusterNode } from './cluster-node-history-store'

/**
 * The payload of `agent.offline`, built from what Moleculer told us.
 *
 * `unexpected` is Moleculer's own verdict on `$node.disconnected`: `true` when
 * the heartbeat or the socket was lost, `false` when the node sent its
 * DISCONNECT on a clean stop. The notification centre turns it into the body
 * of the "node offline" notification (D820).
 */
export function agentOfflineData(
  agentId: string,
  unexpected: boolean | undefined,
  nodeName: string | undefined,
): EventCatalog['agent.offline'] {
  return {
    agentId,
    ...(nodeName !== undefined ? { nodeName } : {}),
    ...(unexpected !== undefined
      ? { reason: unexpected ? ('connection-lost' as const) : ('shutdown' as const) }
      : {}),
  }
}

/** The history's display name for a node — only a real one, never the id echoed back. */
export function nodeDisplayName(
  nodeId: string,
  history: readonly PersistedClusterNode[] | null,
): string | undefined {
  const name = history?.find((row) => row.id === nodeId)?.name
  return name !== undefined && name.length > 0 && name !== nodeId ? name : undefined
}
