/**
 * computeTopology — an ONLINE agent whose capability registration the hub does
 * not hold is reported (`capabilitiesRegistered: false`), never silently
 * capless (2026-10-14: agent-a and the Mac were `isOnline: true` with
 * zero capabilities for 50 minutes and nothing said so).
 */
import { describe, expect, it } from 'vitest'
import { computeTopology } from '../../api/core/cap-providers'

function liveNode(id: string, isHub: boolean, isOnline: boolean) {
  return {
    info: {
      id,
      name: id,
      hostname: id,
      platform: 'linux',
      arch: 'x64',
      cpuModel: null,
      cpuCores: 4,
      memoryMB: 8192,
      pythonRuntimes: [],
    },
    status: { cpuPercent: 1, memoryPercent: 1 },
    isHub,
    isOnline,
    connectedSince: Date.now(),
    subProcesses: [],
    agentAddons: [],
    localIps: [],
  }
}

const registry = {
  listNodes: async () => [
    liveNode('hub', true, true),
    liveNode('agent-a', false, true),
    liveNode('agent-b', false, true),
    liveNode('mac', false, false),
  ],
  getClusterNodeHistory: async () => [],
}

describe('computeTopology — capability registration of online agents', () => {
  it('says which online agent the hub holds no registration for', async () => {
    const rows = await computeTopology(
      // @ts-expect-error -- structural test double for AgentRegistryService
      registry,
      undefined,
      undefined,
      (nodeId: string) => nodeId === 'agent-b',
    )
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get('agent-a')?.capabilitiesRegistered).toBe(false)
    expect(byId.get('agent-b')?.capabilitiesRegistered).toBe(true)
    // The hub and an offline row carry no such claim.
    expect(byId.get('hub')).not.toHaveProperty('capabilitiesRegistered')
    expect(byId.get('mac')).not.toHaveProperty('capabilitiesRegistered')
  })

  it('without a lookup the field is absent, never a guessed false', async () => {
    // @ts-expect-error -- structural test double for AgentRegistryService
    const rows = await computeTopology(registry)
    for (const row of rows) expect(row).not.toHaveProperty('capabilitiesRegistered')
  })
})
