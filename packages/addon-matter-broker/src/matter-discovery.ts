import { DeviceType, type DiscoveredChildDevice } from '@camstack/types'
import type { MatterNodeSnapshot } from './matter-controller.js'
import { endpointLabel, mapMatterEndpointToCamStack } from './matter-cluster-mapping.js'

/**
 * Build one adoption candidate (a {@link DeviceType.Container}) per commissioned
 * Matter node, with one preview accessory child per mappable endpoint. Pure: no
 * I/O, no matter.js import. Endpoints with no recognised cluster (no caps) are
 * skipped so the candidate only previews endpoints that will register caps.
 *
 * One node = one Container; its endpoints become accessory children, mirroring
 * the Ecowitt gateway → sensors model and an HA physical device → entities.
 */
export function buildMatterNodeCandidate(input: {
  readonly node: MatterNodeSnapshot
  /** Adopted CamStack device id for this node, or null when not yet adopted. */
  readonly adoptedDeviceId: number | null
}): DiscoveredChildDevice {
  const { node, adoptedDeviceId } = input

  const children: DiscoveredChildDevice[] = []
  for (const endpoint of node.endpoints) {
    const mapping = mapMatterEndpointToCamStack(endpoint.clusterIds)
    if (mapping.capabilities.length === 0) continue
    children.push({
      childNativeId: endpointNativeId(node.nodeId, endpoint.endpointId),
      name: endpointLabel(endpoint.endpointId, mapping.deviceType),
      type: mapping.deviceType,
      status: node.online ? 'online' : 'offline',
      metadata: { uid: endpointNativeId(node.nodeId, endpoint.endpointId) },
      alreadyAdopted: false,
      adoptedDeviceId: null,
      capabilities: [...mapping.capabilities],
    })
  }

  return {
    childNativeId: node.nodeId,
    name: node.label.length > 0 ? node.label : `Matter node ${node.nodeId}`,
    type: DeviceType.Container,
    status: node.online ? 'online' : 'offline',
    metadata: { serialNumber: node.nodeId },
    alreadyAdopted: adoptedDeviceId !== null,
    adoptedDeviceId,
    capabilities: [],
    children,
  }
}

/** Stable native id for an endpoint child: `node:endpoint`. */
export function endpointNativeId(nodeId: string, endpointId: number): string {
  return `${nodeId}:${endpointId}`
}
