import {
  coverCapability,
  DeviceType,
  type DiscoveredChildDevice,
  floodCapability,
} from '@camstack/types'
import type { VeluxNode } from './velux-client-contract.js'
import { nodeNativeKey } from './velux-protocol.js'

const RAIN_SUFFIX = ':rain'

/**
 * The `childNativeId` of a node's cover candidate. It is the node's serial when
 * the gateway reports one (a node id is only an index into the gateway's system
 * table and can be reused after a node is removed), namespaced under the gateway
 * stableId so two gateways never collide. It is also the cover device's stableId.
 */
export function nodeNativeId(
  gatewayId: string,
  node: { readonly serial: string; readonly nodeId: number },
): string {
  return nodeNativeKey(gatewayId, node)
}

/** The `childNativeId` of the rain sensor of a window that carries one. */
export function rainNativeId(
  gatewayId: string,
  node: { readonly serial: string; readonly nodeId: number },
): string {
  return `${nodeNativeKey(gatewayId, node)}${RAIN_SUFFIX}`
}

/** What a native id points at on the gateway. */
export interface ResolvedNativeId {
  readonly kind: 'cover' | 'rain'
  readonly node: VeluxNode
}

/** Resolve a native id against the gateway's current nodes, or null when none matches. */
export function findNodeByNativeId(
  gatewayId: string,
  nodes: readonly VeluxNode[],
  childNativeId: string,
): ResolvedNativeId | null {
  for (const node of nodes) {
    if (childNativeId === nodeNativeId(gatewayId, node)) return { kind: 'cover', node }
    if (node.rainSensor && childNativeId === rainNativeId(gatewayId, node)) {
      return { kind: 'rain', node }
    }
  }
  return null
}

/** Inputs for {@link buildNodeCandidates}. */
export interface BuildNodeCandidatesInput {
  readonly gatewayId: string
  readonly gatewayName: string
  readonly nodes: readonly VeluxNode[]
  /** Adopted CamStack device id PER native id, or null when not adopted. */
  readonly adoptedDeviceIdByNativeId: Readonly<Record<string, number | null>>
}

/**
 * One {@link DeviceType.Cover} adoption candidate per actuator node, plus a
 * {@link DeviceType.Sensor} rain candidate for each window with an integrated
 * rain sensor. Pure — no I/O.
 */
export function buildNodeCandidates(
  input: BuildNodeCandidatesInput,
): readonly DiscoveredChildDevice[] {
  const out: DiscoveredChildDevice[] = []
  for (const node of input.nodes) {
    const name =
      node.name.length > 0 ? node.name : `${input.gatewayName} — ${node.coverClass} ${node.nodeId}`
    const status = node.online ? 'online' : 'offline'

    const coverId = nodeNativeId(input.gatewayId, node)
    const adoptedCover = input.adoptedDeviceIdByNativeId[coverId] ?? null
    out.push({
      childNativeId: coverId,
      name,
      type: DeviceType.Cover,
      status,
      // The authoritative class is re-read from the live node on adopt.
      metadata: { model: node.coverClass },
      alreadyAdopted: adoptedCover !== null,
      adoptedDeviceId: adoptedCover,
      capabilities: [coverCapability.name],
    })

    if (node.rainSensor) {
      const rainId = rainNativeId(input.gatewayId, node)
      const adoptedRain = input.adoptedDeviceIdByNativeId[rainId] ?? null
      out.push({
        childNativeId: rainId,
        name: `${name} rain`,
        type: DeviceType.Sensor,
        status,
        metadata: { model: 'rain sensor' },
        alreadyAdopted: adoptedRain !== null,
        adoptedDeviceId: adoptedRain,
        capabilities: [floodCapability.name],
      })
    }
  }
  return out
}
