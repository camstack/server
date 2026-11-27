/**
 * Pure topology builder for the `device-mesh` capability: node facts in, nodes
 * and links out. Thread links come from each node's own neighbor and route
 * tables; a peer address that matches no commissioned node (another ecosystem's
 * border router, a router of a neighbouring network) becomes a node with
 * `deviceId: null`.
 */

import type { MeshLink, MeshNode, MeshRole, MeshTopology } from '@camstack/types'
import type { NodeMeshFacts } from './matter-mesh-decode.js'

/** One commissioned node as the builder sees it. */
export interface MeshNodeInput {
  readonly nodeId: string
  readonly label: string
  readonly online: boolean
  readonly deviceId: number | null
  readonly facts: NodeMeshFacts
}

/** Key of a peer this provider did not commission. */
export function peerNodeKey(extAddress: string): string {
  return `thread:${extAddress}`
}

/** `extAddress → nodeId` for every commissioned node whose Thread address is known. */
function ownAddressMap(nodes: readonly MeshNodeInput[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>()
  for (const node of nodes) {
    const ext = node.facts.thread?.ownExtAddress ?? null
    if (ext !== null) map.set(ext, node.nodeId)
  }
  return map
}

/**
 * Each commissioned node's own RLOC16, read off the tables of the nodes that list
 * it (the Thread diagnostics cluster has no attribute for it). Absent = no peer
 * lists this node.
 */
export function rloc16Map(nodes: readonly MeshNodeInput[]): ReadonlyMap<string, number> {
  const own = ownAddressMap(nodes)
  const out = new Map<string, number>()
  for (const node of nodes) {
    const thread = node.facts.thread
    if (thread === null) continue
    for (const entry of [...(thread.neighbors ?? []), ...(thread.routes ?? [])]) {
      const owner = own.get(entry.extAddress)
      if (owner !== undefined && entry.rloc16 !== null && !out.has(owner))
        out.set(owner, entry.rloc16)
    }
  }
  return out
}

function peerRole(isChild: boolean | null, fullThreadDevice: boolean | null): MeshRole {
  if (isChild === true) return 'end-device'
  if (fullThreadDevice === true) return 'router'
  return 'unknown'
}

/** A child's own signal figures: its best neighbor entry (the parent). Routers: unknown. */
function leafSignal(node: MeshNodeInput): {
  rssi: number | null
  lqi: number | null
} {
  const { facts } = node
  if (facts.wifi !== null) return { rssi: facts.wifi.rssi, lqi: null }
  if (facts.role !== 'end-device' && facts.role !== 'sleepy-end-device')
    return { rssi: null, lqi: null }
  const neighbors = facts.thread?.neighbors ?? []
  let best: { rssi: number | null; lqi: number | null } | null = null
  for (const n of neighbors) {
    if (n.lqi === null) continue
    if (best === null || n.lqi > (best.lqi ?? -1))
      best = { rssi: n.averageRssi ?? n.lastRssi, lqi: n.lqi }
  }
  return best ?? { rssi: null, lqi: null }
}

export function buildTopology(nodes: readonly MeshNodeInput[]): MeshTopology {
  const own = ownAddressMap(nodes)
  const meshNodes: MeshNode[] = nodes.map((node) => ({
    deviceId: node.deviceId,
    nodeKey: node.nodeId,
    label: node.label,
    transport: node.facts.transport,
    role: node.facts.role,
    power: node.facts.power,
    online: node.online,
    ...leafSignal(node),
    lastReadAt: node.facts.readAt,
  }))
  const links: MeshLink[] = []
  const seenLinks = new Set<string>()
  const peers = new Map<string, MeshNode>()

  const target = (ext: string, isChild: boolean | null, full: boolean | null): string => {
    const owner = own.get(ext)
    if (owner !== undefined) return owner
    const key = peerNodeKey(ext)
    if (!peers.has(key)) {
      peers.set(key, {
        deviceId: null,
        nodeKey: key,
        label: `Thread device ${ext.slice(-6)}`,
        transport: 'thread',
        role: peerRole(isChild, full),
        power: 'unknown',
        online: true,
        rssi: null,
        lqi: null,
        lastReadAt: null,
      })
    }
    return key
  }
  const addLink = (link: MeshLink): void => {
    const id = `${link.from}|${link.to}|${link.kind}`
    if (seenLinks.has(id) || link.from === link.to) return
    seenLinks.add(id)
    links.push(link)
  }

  for (const node of nodes) {
    const thread = node.facts.thread
    if (thread === null) continue
    for (const n of thread.neighbors ?? []) {
      addLink({
        from: node.nodeId,
        to: target(n.extAddress, n.isChild, n.fullThreadDevice),
        kind: 'neighbor',
        lqi: n.lqi,
        rssi: n.averageRssi ?? n.lastRssi,
      })
    }
    for (const r of thread.routes ?? []) {
      if (r.linkEstablished !== true) continue
      addLink({
        from: node.nodeId,
        to: target(r.extAddress, null, true),
        kind: 'route',
        lqi: r.lqiOut,
        rssi: null,
      })
    }
  }
  const readTimes = nodes.map((n) => n.facts.readAt).filter((t): t is number => t !== null)
  return {
    readAt: readTimes.length === 0 ? null : Math.max(...readTimes),
    nodes: [...meshNodes, ...peers.values()],
    links,
  }
}
