/**
 * computeTopology — an agent's core process reports its own RSS (it used to be
 * a hard 0, so the largest process on a Mac agent could not be attributed), and
 * a node whose memory read failed is `null`, never 0 or 100 (D393).
 */
import { describe, expect, it } from 'vitest'
import { computeTopology } from '../../api/core/cap-providers'

function agent(status: { memoryPercent: number | null; processRssBytes?: number | null }) {
  return {
    info: {
      id: 'mac',
      name: 'mac',
      hostname: 'mac',
      platform: 'darwin',
      arch: 'arm64',
      cpuModel: null,
      cpuCores: 8,
      memoryMB: 16384,
      pythonRuntimes: [],
    },
    status: { cpuPercent: 1, ...status },
    isHub: false,
    isOnline: true,
    connectedSince: Date.now(),
    subProcesses: [],
    agentAddons: [],
    localIps: [],
  }
}

async function topologyOf(node: ReturnType<typeof agent>) {
  const registry = { listNodes: async () => [node], getClusterNodeHistory: async () => [] }
  // @ts-expect-error -- structural test double for AgentRegistryService
  const rows = await computeTopology(registry)
  return rows[0]!
}

describe('computeTopology — core process memory', () => {
  it('reports the agent core RSS from $agent.status', async () => {
    const row = await topologyOf(agent({ memoryPercent: 61, processRssBytes: 1_300_000_000 }))
    expect(row.processes[0]?.memoryRss).toBe(1_300_000_000)
    expect(row.memoryPercent).toBe(61)
  })

  it('a failed memory read is null, not 0', async () => {
    const row = await topologyOf(agent({ memoryPercent: null }))
    expect(row.memoryPercent).toBeNull()
  })
})
