/**
 * One explicit attribute read on a commissioned matter.js client node:
 * `interaction.read(Read({ attributes }))`, the on-demand counterpart of the
 * sustained subscription in `matter-peer-subscribe.ts`. Each `(endpoint,
 * cluster)` request is a wildcard on the attribute, so one round trip returns a
 * whole cluster; a cluster the endpoint does not serve simply returns nothing.
 */

import { Read } from '@matter/protocol'
import { ClusterId, EndpointNumber } from '@matter/main'
import type { MatterAttributeReport } from './matter-controller.js'
import { collectAttributeReports, materialiseUpdate } from './matter-subscription.js'

/** One `(endpoint, cluster)` to read in full. */
export interface PeerReadRequest {
  readonly endpointId: number
  readonly clusterId: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Read the requested clusters off a peer. Throws when the peer has no
 * `interaction.read` or the read fails (timeout, peer asleep): the caller
 * decides what a failed read means; this never turns one into an empty answer.
 */
export async function readPeerAttributes(
  peer: unknown,
  nodeId: string,
  requests: readonly PeerReadRequest[],
): Promise<MatterAttributeReport[]> {
  if (!isRecord(peer)) throw new Error('matter-broker: peer is not readable')
  const interaction = peer['interaction']
  if (!isRecord(interaction) || typeof interaction['read'] !== 'function') {
    throw new Error('matter-broker: peer has no attribute read')
  }
  const request = Read({
    attributes: requests.map((r) => ({
      endpointId: EndpointNumber(r.endpointId),
      clusterId: ClusterId(r.clusterId),
    })),
  })
  const result: unknown = Reflect.apply(interaction['read'], interaction, [request])
  const records = await materialiseUpdate(result)
  return collectAttributeReports(nodeId, records)
}
