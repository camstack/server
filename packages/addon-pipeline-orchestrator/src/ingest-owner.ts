import type { IngestOwner } from '@camstack/types'

interface ClusterRolesLike {
  readonly ingestNode: string
  readonly audioNode: string
}

/**
 * The cluster's single camera-source owner + its LAN-reachable host, resolved
 * UNCONDITIONALLY from `clusterRoles.ingestNode` (NOT `resolveSourceOwner`,
 * which is gated on the detection-decode `remoteSourcingNodes` knob). Consumers
 * (recorder/snapshot/audio) pin their broker calls to `ownerNodeId` and dial
 * `reachableHost`. Defaults to `{ ownerNodeId: 'hub' }` — byte-identical to
 * today's hub-only behavior.
 *
 * `configIssue` is a NON-FATAL guard: when the configured ingest owner is an
 * agent that's unreachable or not ingest-capable, it surfaces a human-readable
 * warning string. The hub is always assumed reachable and ingest-capable, so
 * `ownerNodeId === 'hub'` never produces a `configIssue`.
 */
export function resolveIngestOwner(
  clusterRoles: ClusterRolesLike,
  reachableHostByNode: ReadonlyMap<string, string>,
  ingestCapableNodes: readonly string[],
): IngestOwner {
  const ownerNodeId = clusterRoles.ingestNode
  const reachableHost = reachableHostByNode.get(ownerNodeId)
  const configIssue = computeIngestConfigIssue(ownerNodeId, reachableHost, ingestCapableNodes)
  return {
    ownerNodeId,
    ...(reachableHost !== undefined ? { reachableHost } : {}),
    ...(configIssue !== undefined ? { configIssue } : {}),
  }
}

function computeIngestConfigIssue(
  ownerNodeId: string,
  reachableHost: string | undefined,
  ingestCapableNodes: readonly string[],
): string | undefined {
  if (ownerNodeId === 'hub') return undefined
  if (reachableHost === undefined) {
    return `ingest node '${ownerNodeId}' has no reachable host — set its reachableHost or cameras cannot be sourced from it`
  }
  if (!ingestCapableNodes.includes(ownerNodeId)) {
    return `ingest node '${ownerNodeId}' is not ingest-capable — enable its ingest capability`
  }
  return undefined
}
