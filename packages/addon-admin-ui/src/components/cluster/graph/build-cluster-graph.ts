import type { NodeData, NodeProcess, ServiceInfo } from '../NodeCard'

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface RunnerCap {
  name: string
  addonId: string
}

export interface RunnerBlock {
  pid: number
  name: string
  /** Primary service addonId (first service), '' if none. */
  addonId: string
  cpu: number
  mem: number
  state: string
  /** Union of services[].capabilities, each labelled with its service.addonId, deduped by (name+addonId), sorted by name. */
  caps: RunnerCap[]
}

export interface ClusterGraphNodeIdentity {
  name: string
  ip: string
  cpu: number
  /** Percent; `null` when the node's memory read failed (D393). */
  mem: number | null
  platform: string
  arch: string
}

export interface ClusterGraphNode {
  nodeId: string
  isHub: boolean
  isOnline: boolean
  /** ISO string or epoch ms of the node's last liveness signal (offline hint). */
  lastSeen?: string | number
  identity: ClusterGraphNodeIdentity
  runners: RunnerBlock[]
}

/** online=false → dashed/dimmed edge */
export interface ClusterGraphEdge {
  id: string
  source: string
  target: string
  online: boolean
}

export interface ClusterGraph {
  nodes: ClusterGraphNode[]
  edges: ClusterGraphEdge[]
}

// ---------------------------------------------------------------------------
// Pure mapping helpers
// ---------------------------------------------------------------------------

function buildRunnerCaps(services: readonly ServiceInfo[] | undefined): RunnerCap[] {
  if (services === undefined || services.length === 0) {
    return []
  }

  const seen = new Set<string>()
  const caps: RunnerCap[] = []

  for (const service of services) {
    for (const capName of service.capabilities) {
      const key = `${capName}\0${service.addonId}`
      if (!seen.has(key)) {
        seen.add(key)
        caps.push({ name: capName, addonId: service.addonId })
      }
    }
  }

  return caps.toSorted((a, b) => a.name.localeCompare(b.name))
}

function buildRunnerBlock(process: NodeProcess): RunnerBlock {
  const services = process.services
  return {
    pid: process.pid,
    name: process.name,
    addonId: services?.[0]?.addonId ?? '',
    cpu: process.cpuPercent,
    mem: process.memoryRss,
    state: process.state,
    caps: buildRunnerCaps(services),
  }
}

function buildGraphNode(node: NodeData): ClusterGraphNode {
  return {
    nodeId: node.id,
    isHub: node.isHub,
    isOnline: node.isOnline,
    lastSeen: node.lastSeen,
    identity: {
      name: node.name,
      ip: node.localIps?.[0] ?? '',
      cpu: node.cpuPercent,
      mem: node.memoryPercent,
      platform: node.platform,
      arch: node.arch,
    },
    runners: node.processes.map(buildRunnerBlock),
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function buildClusterGraph(topology: readonly NodeData[]): ClusterGraph {
  // Hub nodes first, then non-hub in original order (stable sort).
  const sorted = topology.toSorted((a, b) => {
    const aHub = a.isHub ? 1 : 0
    const bHub = b.isHub ? 1 : 0
    return bHub - aHub
  })

  const nodes = sorted.map(buildGraphNode)

  const hubNode = nodes.find((n) => n.isHub)

  if (hubNode === undefined) {
    return { nodes, edges: [] }
  }

  const edges: ClusterGraphEdge[] = nodes
    .filter((n) => !n.isHub)
    .map((n) => ({
      id: `hub:${hubNode.nodeId}->${n.nodeId}`,
      source: hubNode.nodeId,
      target: n.nodeId,
      online: n.isOnline && hubNode.isOnline,
    }))

  return { nodes, edges }
}
