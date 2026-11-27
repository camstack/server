import { describe, expect, it } from 'vitest'
import type { MeshNode, MeshTopology } from '@camstack/types'
import {
  collectMeshNetworks,
  networkHasDevice,
  lqiTone,
  meshStats,
  medianOf,
  parentRouterOf,
} from '../device-mesh-model'

const node = (over: Partial<MeshNode> & { nodeKey: string }): MeshNode => ({
  deviceId: null,
  label: over.nodeKey,
  transport: 'thread',
  role: 'end-device',
  power: 'mains',
  online: true,
  rssi: null,
  lqi: null,
  lastReadAt: null,
  ...over,
})

const topo = (nodes: MeshNode[], links: MeshTopology['links'] = []): MeshTopology => ({
  network: null,
  readAt: null,
  nodes,
  links,
})

describe('device-mesh model', () => {
  it('an unreported LQI is unknown, never poor', () => {
    expect(lqiTone(null)).toBe('unknown')
    expect(lqiTone(0)).toBe('poor')
    expect(lqiTone(200)).toBe('good')
    expect(lqiTone(120)).toBe('fair')
  })

  it('the median skips unknown values and is null over none', () => {
    expect(medianOf([])).toBeNull()
    const stats = meshStats(
      topo([
        node({ nodeKey: 'a', lqi: 100, role: 'router' }),
        node({ nodeKey: 'b', lqi: null, online: false }),
        node({ nodeKey: 'c', lqi: 200 }),
      ]),
    )
    expect(stats).toEqual({ nodes: 3, online: 2, routers: 1, medianLqi: 150 })
    expect(meshStats(topo([node({ nodeKey: 'x' })])).medianLqi).toBeNull()
  })

  it('the parent router is the routing peer with the best link', () => {
    const t = topo(
      [
        node({ nodeKey: 'leaf' }),
        node({ nodeKey: 'r1', role: 'router' }),
        node({ nodeKey: 'r2', role: 'router' }),
        node({ nodeKey: 'peer' }),
      ],
      [
        { from: 'leaf', to: 'r1', kind: 'neighbor', lqi: 90, rssi: null },
        { from: 'r2', to: 'leaf', kind: 'neighbor', lqi: 200, rssi: null },
        { from: 'leaf', to: 'peer', kind: 'neighbor', lqi: 255, rssi: null },
      ],
    )
    expect(parentRouterOf(t, 'leaf')?.nodeKey).toBe('r2')
    expect(parentRouterOf(t, 'peer')).toBeNull()
  })

  it('reads each network once, and a failed read is its own network with the reason', async () => {
    const reads: number[] = []
    const fabricA = topo([node({ nodeKey: '1', deviceId: 1 }), node({ nodeKey: '2', deviceId: 2 })])
    const fabricB = topo([node({ nodeKey: '1', deviceId: 3 })])
    const result = await collectMeshNetworks([1, 2, 3, 4], async (id) => {
      reads.push(id)
      if (id === 4) throw new Error('broker offline')
      return id === 3 ? fabricB : fabricA
    })
    expect(reads).toEqual([1, 3, 4])
    expect(result.map((n) => n.rootDeviceId)).toEqual([1, 3, 4])
    expect(result[2]).toMatchObject({
      topology: null,
      error: 'broker offline',
    })
  })

  it('merges two reads of one network id: every node of both, either device found', async () => {
    const info = {
      id: '00112233aabbccdd',
      name: 'Home',
      technology: 'thread' as const,
      channel: 15,
      panId: 1,
    }
    const a = {
      ...topo(
        [node({ nodeKey: '1', deviceId: 1 }), node({ nodeKey: '2', deviceId: 2, lastReadAt: 5 })],
        [{ from: '1', to: '2', kind: 'neighbor', lqi: 100, rssi: null }],
      ),
      network: info,
      readAt: 10,
    }
    // Another broker: its own key space ('1' collides), one device in common (2), newer data.
    const b = {
      ...topo(
        [node({ nodeKey: '1', deviceId: 3 }), node({ nodeKey: '7', deviceId: 2, lastReadAt: 9 })],
        [{ from: '1', to: '7', kind: 'neighbor', lqi: 90, rssi: null }],
      ),
      network: info,
      readAt: 20,
    }
    const result = await collectMeshNetworks([1, 3], async (id) => (id === 1 ? a : b))
    expect(result).toHaveLength(1)
    const network = result[0]
    if (network === undefined) throw new Error('no network')
    expect(network.topology?.nodes.map((n) => n.deviceId).sort()).toEqual([1, 2, 3])
    expect(network.topology?.readAt).toBe(20)
    expect(networkHasDevice(network, 1)).toBe(true)
    expect(networkHasDevice(network, 3)).toBe(true)
    // The newer per-node read of device 2 won; the renamed link points at real nodes.
    expect(network.topology?.nodes.find((n) => n.deviceId === 2)?.lastReadAt).toBe(9)
    const keys = new Set(network.topology?.nodes.map((n) => n.nodeKey))
    for (const l of network.topology?.links ?? []) {
      expect(keys.has(l.from)).toBe(true)
      expect(keys.has(l.to)).toBe(true)
    }
    expect(keys.size).toBe(3)
  })
  it('splits one answer spanning two networks into two sections', async () => {
    const answer = {
      ...topo(
        [
          node({ nodeKey: '1', deviceId: 1, networkId: 'aa' }),
          node({ nodeKey: '2', deviceId: 2, networkId: 'bb' }),
        ],
        [],
      ),
      network: { id: 'aa', name: 'A', technology: 'thread' as const, channel: null, panId: null },
    }
    const result = await collectMeshNetworks([1], async () => answer)
    expect(result.map((n) => n.topology?.network?.id)).toEqual(['aa', 'bb'])
    expect(result.map((n) => n.topology?.nodes.length)).toEqual([1, 1])
    expect(result.some((n) => networkHasDevice(n, 2))).toBe(true)
  })
})
