import { describe, expect, it } from 'vitest'
import type { MeshNode, MeshTopology } from '@dominevo/types'
import { layoutMesh, meshEdges } from '../mesh-map-model'

const node = (nodeKey: string, role: MeshNode['role']): MeshNode => ({
  deviceId: null,
  nodeKey,
  label: nodeKey,
  transport: 'thread',
  role,
  power: 'mains',
  online: true,
  rssi: null,
  lqi: null,
  lastReadAt: null,
})

describe('mesh map model', () => {
  it('puts a lone border router in the middle and gives every node one point', () => {
    const nodes = [node('br', 'border-router'), node('r', 'router'), node('e', 'end-device')]
    const points = layoutMesh(nodes)
    expect(points.map((p) => p.nodeKey).sort()).toEqual(['br', 'e', 'r'])
    expect(points.find((p) => p.nodeKey === 'br')).toMatchObject({
      x: 0,
      y: 0,
    })
  })

  it('keeps one edge per pair, the better link, tinted by tone, and drops dangling links', () => {
    const topology: MeshTopology = {
      network: null,
      readAt: null,
      nodes: [node('a', 'router'), node('b', 'end-device')],
      links: [
        { from: 'a', to: 'b', kind: 'neighbor', lqi: 40, rssi: null },
        { from: 'b', to: 'a', kind: 'neighbor', lqi: 220, rssi: null },
        { from: 'a', to: 'ghost', kind: 'route', lqi: 255, rssi: null },
      ],
    }
    const edges = meshEdges(topology)
    expect(edges).toHaveLength(1)
    expect(edges[0]?.stroke).toBe('var(--color-success)')
  })
})
