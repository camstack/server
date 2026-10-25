import { coverCapability, DeviceType, type DiscoveredChildDevice } from '@camstack/types'
import type { VeluxNode } from './velux-client-contract.js'

/**
 * The `childNativeId` a discovered Velux node candidate is keyed on. The KLF-200
 * node id is stable across reboots; it is namespaced under the gateway stableId
 * so two gateways never collide.
 */
export function nodeNativeId(gatewayId: string, nodeId: number): string {
  return `${gatewayId}:node:${nodeId}`
}

/** Extract the numeric KLF-200 node id from a {@link nodeNativeId} value. */
export function parseNodeNativeId(childNativeId: string): number | null {
  const marker = ':node:'
  const idx = childNativeId.lastIndexOf(marker)
  if (idx < 0) return null
  const parsed = Number.parseInt(childNativeId.slice(idx + marker.length), 10)
  return Number.isNaN(parsed) ? null : parsed
}

/** Inputs for {@link buildNodeCandidates}. */
export interface BuildNodeCandidatesInput {
  readonly gatewayId: string
  readonly gatewayName: string
  readonly nodes: readonly VeluxNode[]
  /** Adopted CamStack device id PER node id, or null when not adopted. */
  readonly adoptedDeviceIdByNode: Readonly<Record<number, number | null>>
}

/**
 * Build one {@link DeviceType.Cover} adoption candidate per KLF-200 actuator node
 * on the gateway. Pure — no I/O. Unit-testable in isolation.
 */
export function buildNodeCandidates(
  input: BuildNodeCandidatesInput,
): readonly DiscoveredChildDevice[] {
  return input.nodes.map((node) => {
    const adoptedDeviceId = input.adoptedDeviceIdByNode[node.nodeId] ?? null
    return {
      childNativeId: nodeNativeId(input.gatewayId, node.nodeId),
      name:
        node.name.length > 0
          ? node.name
          : `${input.gatewayName} — ${node.coverClass} ${node.nodeId}`,
      type: DeviceType.Cover,
      status: node.online ? 'online' : 'offline',
      // `coverClass` is carried in `metadata.model` for the adoption panel; the
      // authoritative value is re-read from the live node on adopt.
      metadata: { model: node.coverClass },
      alreadyAdopted: adoptedDeviceId !== null,
      adoptedDeviceId,
      capabilities: [coverCapability.name],
    } satisfies DiscoveredChildDevice
  })
}
