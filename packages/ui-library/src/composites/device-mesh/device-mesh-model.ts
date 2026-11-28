/**
 * Pure model of the `device-mesh` views: link-quality tone, the KPI row, the
 * parent router of a node, and how the networks of every provider are
 * enumerated from the per-device `getTopology` answers.
 *
 * Nothing here turns "unknown" into a number (D393): an LQI the node did not
 * report is `null`, a median over no known value is `null`, and a network whose
 * read failed carries `topology: null` and the reason.
 */
import type { MeshLink, MeshNetworkInfo, MeshNode, MeshRole, MeshTopology } from '@dominevo/types'

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

/** Does the network list this Dominevo device as one of its nodes? */
export function networkHasDevice(network: MeshNetwork, deviceId: number): boolean {
  return (
    network.rootDeviceId === deviceId ||
    (network.topology?.nodes.some((n) => n.deviceId === deviceId) ?? false)
  )
}

/**
 * One answer split by `node.networkId`: a provider whose answer spans several
 * networks (a Matter fabric over two Thread networks) gets one topology per
 * network. A node without a `networkId` belongs to the answer's own network.
 */
export function splitByNetwork(topology: MeshTopology): readonly MeshTopology[] {
  const own = topology.network?.id ?? null
  const idOf = (n: MeshNode): string | null => n.networkId ?? own
  const ids = [...new Set(topology.nodes.map(idOf))]
  if (ids.length <= 1) return [topology]
  return ids.map((id) => {
    const nodes = topology.nodes.filter((n) => idOf(n) === id)
    const keys = new Set(nodes.map((n) => n.nodeKey))
    const network: MeshNetworkInfo | null =
      id === null
        ? null
        : id === own
          ? topology.network
          : {
              id,
              name: null,
              technology: topology.network?.technology ?? 'thread',
              channel: null,
              panId: null,
            }
    return {
      network,
      readAt: topology.readAt,
      nodes,
      links: topology.links.filter((l) => keys.has(l.from) && keys.has(l.to)),
    }
  })
}

const newest = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.max(a, b)

/**
 * Merge two reads of one network. A node is the same node when it is the same
 * Dominevo device (or the same peer key of a device-less peer); the newer
 * per-node read wins. Node keys are provider-scoped, so an incoming key that
 * collides with a different node is renamed before its links are carried over.
 */
export function mergeTopologies(
  base: MeshTopology,
  incoming: MeshTopology,
  incomingRoot: number,
): MeshTopology {
  const nodes: MeshNode[] = [...base.nodes]
  const remap = new Map<string, string>()
  for (const node of incoming.nodes) {
    const same = nodes.findIndex((n) =>
      node.deviceId !== null
        ? n.deviceId === node.deviceId
        : n.deviceId === null && n.nodeKey === node.nodeKey,
    )
    if (same !== -1) {
      const held = nodes[same]
      if (held === undefined) continue
      remap.set(node.nodeKey, held.nodeKey)
      if ((node.lastReadAt ?? -1) > (held.lastReadAt ?? -1)) {
        nodes[same] = { ...node, nodeKey: held.nodeKey }
      }
      continue
    }
    const clash = nodes.some((n) => n.nodeKey === node.nodeKey)
    const key = clash ? `${incomingRoot}/${node.nodeKey}` : node.nodeKey
    remap.set(node.nodeKey, key)
    nodes.push({ ...node, nodeKey: key })
  }
  const links = [...base.links]
  const seen = new Set(links.map((l) => `${l.from}|${l.to}|${l.kind}`))
  for (const link of incoming.links) {
    const from = remap.get(link.from) ?? link.from
    const to = remap.get(link.to) ?? link.to
    const id = `${from}|${to}|${link.kind}`
    if (seen.has(id) || from === to) continue
    seen.add(id)
    links.push({ ...link, from, to })
  }
  return {
    network: base.network ?? incoming.network,
    readAt: newest(base.readAt, incoming.readAt),
    nodes,
    links,
  }
}

/**
 * One `getTopology` answers for the whole mesh the device sits in, so a network
 * is read once: every device that already appeared as a node of a topology read
 * so far is skipped, and only the first uncovered device is asked next. An answer
 * spanning several networks is split by node; reads that share a `network.id`
 * (two brokers on one Thread network) are merged into one section. A device
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
      const read = await fetchTopology(deviceId)
      for (const node of read.nodes) if (node.deviceId !== null) covered.add(node.deviceId)
      for (const part of splitByNetwork(read)) {
        const id = part.network?.id ?? null
        const same = id === null ? -1 : networks.findIndex((n) => n.topology?.network?.id === id)
        const held = same === -1 ? undefined : networks[same]
        if (held?.topology == null) {
          networks.push({ rootDeviceId: deviceId, topology: part, error: null })
        } else {
          networks[same] = {
            rootDeviceId: held.rootDeviceId,
            topology: mergeTopologies(held.topology, part, deviceId),
            error: null,
          }
        }
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
