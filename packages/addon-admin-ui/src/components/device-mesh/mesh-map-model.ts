/**
 * Pure layout of a mesh topology for the map: backbone nodes (border routers,
 * coordinators) in the middle, routers on a first ring, everything else on an
 * outer ring. Deterministic, so a re-render never moves a node.
 */
import { isRoutingRole, lqiTone, LQI_TONE_STROKE } from '@dominevo/ui-library'
import type { MeshNode, MeshTopology } from '@dominevo/types'

export interface MapPoint {
  readonly nodeKey: string
  readonly x: number
  readonly y: number
}

export interface MapEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly stroke: string
}

/** Nodes are wider than tall, so the rings are ellipses. */
const X_STRETCH = 1.9
const RING_GAP = 150
const MIN_RING = 130
const PER_NODE_ARC = 70

function ring(nodes: readonly MeshNode[], radius: number): MapPoint[] {
  return nodes.map((n, i) => {
    const angle = (2 * Math.PI * i) / Math.max(nodes.length, 1) - Math.PI / 2
    return {
      nodeKey: n.nodeKey,
      x: Math.round(Math.cos(angle) * radius * X_STRETCH) + 0,
      y: Math.round(Math.sin(angle) * radius) + 0,
    }
  })
}

export function layoutMesh(nodes: readonly MeshNode[]): readonly MapPoint[] {
  const backbone = nodes.filter((n) => n.role === 'border-router' || n.role === 'coordinator')
  const routers = nodes.filter((n) => n.role === 'router')
  const rest = nodes.filter((n) => !isRoutingRole(n.role))
  const innerRadius = Math.max(MIN_RING, Math.ceil((routers.length * PER_NODE_ARC) / (2 * Math.PI)))
  const outerRadius = Math.max(
    innerRadius + RING_GAP,
    Math.ceil((rest.length * PER_NODE_ARC) / (2 * Math.PI)),
  )
  return [
    ...(backbone.length === 1 ? ring(backbone, 0) : ring(backbone, 60)),
    ...ring(routers, innerRadius),
    ...ring(rest, outerRadius),
  ]
}

/** One edge per unordered pair, the better-known link wins; stroke is the LQI tone. */
export function meshEdges(topology: MeshTopology): readonly MapEdge[] {
  const keys = new Set(topology.nodes.map((n) => n.nodeKey))
  const byPair = new Map<string, { source: string; target: string; lqi: number | null }>()
  for (const link of topology.links) {
    if (!keys.has(link.from) || !keys.has(link.to)) continue
    const id = [link.from, link.to].sort().join('|')
    const prev = byPair.get(id)
    if (prev === undefined || (link.lqi ?? -1) > (prev.lqi ?? -1)) {
      byPair.set(id, { source: link.from, target: link.to, lqi: link.lqi })
    }
  }
  return [...byPair.entries()].map(([id, e]) => ({
    id,
    source: e.source,
    target: e.target,
    stroke: LQI_TONE_STROKE[lqiTone(e.lqi)],
  }))
}
