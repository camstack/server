/**
 * Pure model of the `device-mesh` views: link-quality tone, the KPI row, the
 * parent router of a node, and how the networks of every provider are
 * enumerated from the per-device `getTopology` answers.
 *
 * Nothing here turns "unknown" into a number (D393): an LQI the node did not
 * report is `null`, a median over no known value is `null`, and a network whose
 * read failed carries `topology: null` and the reason.
 */
import type { MeshLink, MeshNode, MeshRole, MeshTopology } from '@camstack/types'

export type LqiTone = 'good' | 'fair' | 'poor' | 'unknown'

/** LQI is 0..255 on Thread: two thirds and up is a solid link, a third and below is marginal. */
const LQI_GOOD_MIN = 170
const LQI_FAIR_MIN = 85

export function lqiTone(lqi: number | null): LqiTone {
  if (lqi === null) return 'unknown'
  if (lqi >= LQI_GOOD_MIN) return 'good'
  if (lqi >= LQI_FAIR_MIN) return 'fair'
  return 'poor'
}

/** Token utility for text in a tone. */
export const LQI_TONE_TEXT: Readonly<Record<LqiTone, string>> = {
  good: 'text-success',
  fair: 'text-warning',
  poor: 'text-danger',
  unknown: 'text-foreground-subtle',
}

/** CSS variable of a tone, for SVG strokes. */
export const LQI_TONE_STROKE: Readonly<Record<LqiTone, string>> = {
  good: 'var(--color-success)',
  fair: 'var(--color-warning)',
  poor: 'var(--color-danger)',
  unknown: 'var(--color-foreground-subtle)',
}

const ROUTING_ROLES: ReadonlySet<MeshRole> = new Set<MeshRole>([
  'border-router',
  'router',
  'coordinator',
])

export function isRoutingRole(role: MeshRole): boolean {
  return ROUTING_ROLES.has(role)
}

export interface MeshStats {
  readonly nodes: number
  readonly online: number
  readonly routers: number
  /** Median LQI of the nodes that reported one; `null` when none did. */
  readonly medianLqi: number | null
}

export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const lower = sorted[mid - 1]
  const upper = sorted[mid]
  if (upper === undefined) return null
  return sorted.length % 2 === 1 || lower === undefined ? upper : Math.round((lower + upper) / 2)
}

export function meshStats(topology: MeshTopology): MeshStats {
  const lqis: number[] = []
  for (const node of topology.nodes) if (node.lqi !== null) lqis.push(node.lqi)
  return {
    nodes: topology.nodes.length,
    online: topology.nodes.filter((n) => n.online).length,
    routers: topology.nodes.filter((n) => isRoutingRole(n.role)).length,
    medianLqi: medianOf(lqis),
  }
}

/** Every link that touches a node, with the peer's key on the other end. */
export function linksOfNode(
  topology: MeshTopology,
  nodeKey: string,
): readonly { readonly peerKey: string; readonly link: MeshLink }[] {
  const out: { peerKey: string; link: MeshLink }[] = []
  for (const link of topology.links) {
    if (link.from === nodeKey) out.push({ peerKey: link.to, link })
    else if (link.to === nodeKey) out.push({ peerKey: link.from, link })
  }
  return out
}

/** The routing node with the best known link to this node, or `null` when no router reports one. */
export function parentRouterOf(topology: MeshTopology, nodeKey: string): MeshNode | null {
  let best: { node: MeshNode; lqi: number } | null = null
  for (const { peerKey, link } of linksOfNode(topology, nodeKey)) {
    const peer = topology.nodes.find((n) => n.nodeKey === peerKey)
    if (peer === undefined || !isRoutingRole(peer.role)) continue
    const lqi = link.lqi ?? -1
    if (best === null || lqi > best.lqi) best = { node: peer, lqi }
  }
  return best === null ? null : best.node
}

export interface MeshNetwork {
  /** The device the network was read through; stable for the lifetime of the network. */
  readonly rootDeviceId: number
  /** `null` when the read failed: see `error`. */
  readonly topology: MeshTopology | null
  readonly error: string | null
}

/** Does the network list this CamStack device as one of its nodes? */
export function networkHasDevice(network: MeshNetwork, deviceId: number): boolean {
  return (
    network.rootDeviceId === deviceId ||
    (network.topology?.nodes.some((n) => n.deviceId === deviceId) ?? false)
  )
}

/**
 * One `getTopology` answers for the whole mesh the device sits in, so a network
 * is read once: every device that already appeared as a node of a topology read
 * so far is skipped, and only the first uncovered device is asked next. A device
 * whose read fails is its own failed network (nothing says which mesh it is in).
 */
export async function collectMeshNetworks(
  deviceIds: readonly number[],
  fetchTopology: (deviceId: number) => Promise<MeshTopology>,
): Promise<readonly MeshNetwork[]> {
  const networks: MeshNetwork[] = []
  const covered = new Set<number>()
  for (const deviceId of deviceIds) {
    if (covered.has(deviceId)) continue
    covered.add(deviceId)
    try {
      const topology = await fetchTopology(deviceId)
      for (const node of topology.nodes) if (node.deviceId !== null) covered.add(node.deviceId)
      // Two reads of one network (same id) are one section: keep the newer read.
      const id = topology.network?.id ?? null
      const same = id === null ? -1 : networks.findIndex((n) => n.topology?.network?.id === id)
      if (same === -1) {
        networks.push({ rootDeviceId: deviceId, topology, error: null })
      } else if ((topology.readAt ?? -1) > (networks[same]?.topology?.readAt ?? -1)) {
        networks[same] = { rootDeviceId: deviceId, topology, error: null }
      }
    } catch (err) {
      networks.push({
        rootDeviceId: deviceId,
        topology: null,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return networks
}
