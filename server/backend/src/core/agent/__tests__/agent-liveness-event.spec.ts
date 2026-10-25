import { describe, expect, it } from 'vitest'
import { agentOfflineData, nodeDisplayName } from '../agent-liveness-event'
import type { PersistedClusterNode } from '../cluster-node-history-store'

function row(id: string, name: string): PersistedClusterNode {
  return { id, name } as unknown as PersistedClusterNode
}

describe('agentOfflineData', () => {
  it('maps an unexpected disconnect to connection-lost', () => {
    expect(agentOfflineData('agent-a', true, undefined)).toEqual({
      agentId: 'agent-a',
      reason: 'connection-lost',
    })
  })

  it('maps a clean disconnect to shutdown and carries the display name', () => {
    expect(agentOfflineData('mac', false, 'Mac mini')).toEqual({
      agentId: 'mac',
      nodeName: 'Mac mini',
      reason: 'shutdown',
    })
  })

  it('omits the reason when Moleculer did not say', () => {
    expect(agentOfflineData('mac', undefined, undefined)).toEqual({ agentId: 'mac' })
  })
})

describe('nodeDisplayName', () => {
  it('answers a real name only', () => {
    const history = [row('a', 'Agent A'), row('b', 'b'), row('c', '')]
    expect(nodeDisplayName('a', history)).toBe('Agent A')
    expect(nodeDisplayName('b', history)).toBeUndefined()
    expect(nodeDisplayName('c', history)).toBeUndefined()
    expect(nodeDisplayName('z', history)).toBeUndefined()
    expect(nodeDisplayName('a', null)).toBeUndefined()
  })
})
