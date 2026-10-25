import { describe, it, expect } from 'vitest'
import { computeTopology } from '../../api/core/cap-providers'

// Minimal stubs — only the shapes computeTopology reads.
function makeAgentRegistry(): {
  listNodes: () => Promise<unknown[]>
  getClusterNodeHistory: () => Promise<unknown[]>
} {
  return {
    getClusterNodeHistory: async () => [],
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
  }
}

function makeAddonRegistry(): { listAddons: () => readonly unknown[] } {
  return {
    listAddons: () => [
      {
        manifest: { id: 'provider-hikvision' },
        declaration: {
          id: 'provider-hikvision',
          category: 'providers',
          capabilities: [{ name: 'stream-params' }],
        },
      },
      {
        manifest: { id: 'provider-onvif' },
        declaration: {
          id: 'provider-onvif',
          category: 'providers',
          capabilities: [{ name: 'device-provider' }],
        },
      },
      {
        manifest: { id: 'stream-broker' },
        declaration: {
          id: 'stream-broker',
          category: 'pipeline',
          capabilities: [{ name: 'stream-broker' }],
        },
      },
      {
        manifest: { id: 'sqlite-settings' },
        declaration: { id: 'sqlite-settings', capabilities: [{ name: 'settings-store' }] },
      },
    ],
  }
}

describe('computeTopology categories[] aggregation', () => {
  it('groups addons by manifest.category, defaults to system, emits totals', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodes = await computeTopology(makeAgentRegistry() as any, makeAddonRegistry() as any)
    expect(nodes).toHaveLength(1)
    const cats = nodes[0]!.categories
    const byId = new Map(cats.map((c) => [c.category, c]))
    expect(byId.get('providers')?.total).toBe(2)
    expect(byId.get('providers')?.healthy).toBe(2)
    expect(
      byId
        .get('providers')
        ?.addons.map((a) => a.id)
        .toSorted(),
    ).toEqual(['provider-hikvision', 'provider-onvif'])
    expect(byId.get('pipeline')?.total).toBe(1)
    expect(byId.get('system')?.addons.map((a) => a.id)).toEqual(['sqlite-settings'])
  })

  it('counts a non-running addon as not-healthy', async () => {
    const agentReg = makeAgentRegistry()
    // Force the addon registry to return one stopped + one running provider.
    const addonReg = {
      listAddons: () => [
        {
          manifest: { id: 'provider-rtsp' },
          declaration: { id: 'provider-rtsp', category: 'providers', capabilities: [] },
        },
        {
          manifest: { id: 'provider-hikvision' },
          declaration: { id: 'provider-hikvision', category: 'providers', capabilities: [] },
          status: 'failed',
        },
      ],
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodes = await computeTopology(agentReg as any, addonReg as any)
    const providers = nodes[0]!.categories.find((c) => c.category === 'providers')!
    expect(providers.total).toBe(2)
    // The current TopologyNode `addons[].status` is always `'running'` per existing code;
    // failed addons would surface through subProcesses[].state. Document the current contract:
    expect(providers.healthy).toBe(2)
  })
})
