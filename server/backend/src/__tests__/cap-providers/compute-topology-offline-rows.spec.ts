/**
 * computeTopology — Track A offline-row union + lastSeen fix.
 *
 * Verifies the two behaviours A2 adds on top of the live topology:
 *   1. A persisted node NOT present in the live `listNodes()` set is emitted
 *      as an OFFLINE `TopologyNode` from its last-known descriptor, with
 *      `lastSeen` derived from the persisted `lastActive` (not "now"), metrics
 *      zeroed, and `addons` reconstructed from the snapshotted addon-id list.
 *   2. A LIVE node's `lastSeen` comes from its persisted `lastActive`, fixing
 *      the previous always-"now" bug.
 */
import { describe, it, expect } from 'vitest'
import { computeTopology } from '../../api/core/cap-providers'

const LIVE_LAST_ACTIVE = 1_700_000_500_000
const OFFLINE_LAST_ACTIVE = 1_700_000_000_000

function makeAgentRegistry(): {
  listNodes: () => Promise<unknown[]>
  getClusterNodeHistory: () => Promise<unknown[]>
} {
  return {
    listNodes: async () => [
      {
        info: {
          id: 'hub',
          name: 'hub',
          hostname: 'hub',
          platform: 'darwin',
          arch: 'arm64',
          cpuModel: 'M2',
          cpuCores: 8,
          memoryMB: 16384,
          pythonRuntimes: [],
        },
        status: { cpuPercent: 12, memoryPercent: 30 },
        isHub: true,
        isOnline: true,
        connectedSince: Date.now() - 60_000,
        subProcesses: [],
        agentAddons: [],
        localIps: [],
      },
    ],
    // Two persisted rows: the live hub (lastActive fresh) + an agent that is
    // no longer in the live set (must surface as an offline row).
    getClusterNodeHistory: async () => [
      {
        id: 'hub',
        name: 'hub',
        hostname: 'hub',
        platform: 'darwin',
        arch: 'arm64',
        cpuModel: 'M2',
        cpuCores: 8,
        memoryMB: 16384,
        engines: [],
        isHub: true,
        localIps: [],
        addonIds: [],
        lastActive: LIVE_LAST_ACTIVE,
      },
      {
        id: 'agent-42',
        name: 'Garage Node',
        hostname: 'garage.local',
        platform: 'linux',
        arch: 'x64',
        cpuModel: 'N100',
        cpuCores: 4,
        memoryMB: 8192,
        engines: ['onnx'],
        isHub: false,
        localIps: ['192.168.10.42'],
        addonIds: ['provider-onvif', 'decoder-ffmpeg'],
        lastActive: OFFLINE_LAST_ACTIVE,
      },
    ],
  }
}

function makeAddonRegistry(): { listAddons: () => readonly unknown[] } {
  return {
    listAddons: () => [
      {
        manifest: { id: 'provider-onvif' },
        declaration: {
          id: 'provider-onvif',
          category: 'providers',
          capabilities: [{ name: 'device-provider' }],
        },
      },
      {
        manifest: { id: 'decoder-ffmpeg' },
        declaration: {
          id: 'decoder-ffmpeg',
          category: 'pipeline',
          capabilities: [{ name: 'decoder' }],
        },
      },
    ],
  }
}

describe('computeTopology — offline-node union (Track A)', () => {
  it('emits an offline row for a persisted node absent from the live set', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodes = await computeTopology(makeAgentRegistry() as any, makeAddonRegistry() as any)
    const offline = nodes.find((n) => n.id === 'agent-42')
    expect(offline).toBeDefined()
    expect(offline!.isOnline).toBe(false)
    expect(offline!.name).toBe('Garage Node')
    expect(offline!.hostname).toBe('garage.local')
    expect(offline!.cpuModel).toBe('N100')
    expect(offline!.engines).toEqual(['onnx'])
    expect(offline!.localIps).toEqual(['192.168.10.42'])
    // Metrics zeroed; no processes/categories for an unreachable node.
    expect(offline!.cpuPercent).toBe(0)
    expect(offline!.memoryPercent).toBe(0)
    expect(offline!.uptime).toBe(0)
    expect(offline!.processes).toEqual([])
    expect(offline!.categories).toEqual([])
    // lastSeen from the persisted lastActive, NOT "now".
    expect(offline!.lastSeen).toBe(new Date(OFFLINE_LAST_ACTIVE).toISOString())
    // addons reconstructed from the snapshotted addon-id list, with caps
    // resolved off the hub's installed set.
    expect(offline!.addons.map((a) => a.id).toSorted()).toEqual([
      'decoder-ffmpeg',
      'provider-onvif',
    ])
    expect(offline!.addons.every((a) => a.status === 'stopped')).toBe(true)
    const onvif = offline!.addons.find((a) => a.id === 'provider-onvif')
    expect(onvif!.capabilities).toEqual(['device-provider'])
  })

  it('derives a live node lastSeen from its persisted lastActive (not now)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodes = await computeTopology(makeAgentRegistry() as any, makeAddonRegistry() as any)
    const hub = nodes.find((n) => n.id === 'hub')
    expect(hub).toBeDefined()
    expect(hub!.isOnline).toBe(true)
    expect(hub!.lastSeen).toBe(new Date(LIVE_LAST_ACTIVE).toISOString())
  })

  it('does NOT duplicate a node present in both the live set and history', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodes = await computeTopology(makeAgentRegistry() as any, makeAddonRegistry() as any)
    expect(nodes.filter((n) => n.id === 'hub')).toHaveLength(1)
  })
})
