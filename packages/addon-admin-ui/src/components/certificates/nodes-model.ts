/**
 * Pure model of Identity → Certificates → Nodes: the HTTPS certificate a node
 * serves and the cluster identity it presents to the hub are two different
 * certificates from two different CAs, shown as ONE row per node. This file
 * joins the two inventories and owns the per-row action rules.
 */
import type { HttpsNodeRow, MeshInventory, MeshNodeRow } from './certificate-model'
import i18n from '../../i18n/index'

export const HUB_NODE_ID = 'hub'

export interface NodeCertificateRow {
  readonly nodeId: string
  readonly isHub: boolean
  readonly online: boolean
  /** `null` while the HTTPS inventory has no entry for the node. */
  readonly https: HttpsNodeRow | null
  /** `null` when the mesh registry has no entry for the node. */
  readonly mesh: MeshNodeRow | null
}

/** One row per node id found in either inventory; the hub first. */
export function joinNodes(
  https: readonly HttpsNodeRow[],
  mesh: MeshInventory | undefined,
): readonly NodeCertificateRow[] {
  const ids = new Set<string>()
  for (const h of https) ids.add(h.nodeId)
  for (const m of mesh?.nodes ?? []) ids.add(m.nodeId)
  const rows = [...ids].map((nodeId): NodeCertificateRow => {
    const h = https.find((x) => x.nodeId === nodeId) ?? null
    const m = mesh?.nodes.find((x) => x.nodeId === nodeId) ?? null
    return {
      nodeId,
      isHub: h?.isHub ?? nodeId === HUB_NODE_ID,
      online: h?.online ?? m?.online ?? false,
      https: h,
      mesh: m,
    }
  })
  return rows.toSorted(
    (a, b) => Number(b.isHub) - Number(a.isHub) || a.nodeId.localeCompare(b.nodeId),
  )
}

/** Why the cluster-identity Renew / Revoke is off for a row; `null` when offered. */
export function identityBlockedReason(row: NodeCertificateRow): string | null {
  if (row.isHub) {
    return i18n.t('helpers.nodesModel.hubReissued')
  }
  if (row.mesh === null) return i18n.t('helpers.nodesModel.noCertRecorded')
  if (!row.online) return i18n.t('helpers.certificateModel.nodeOffline')
  return null
}

/** Revoke only needs the node to be a recorded non-hub node; it works offline. */
export function identityRevokeBlockedReason(row: NodeCertificateRow): string | null {
  if (row.isHub) return identityBlockedReason(row)
  if (row.mesh === null) return identityBlockedReason(row)
  return null
}
