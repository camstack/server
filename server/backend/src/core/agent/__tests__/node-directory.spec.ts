import { describe, expect, it } from 'vitest'
import { toNodeDirectory } from '../node-directory.js'
import type { PersistedClusterNode } from '../cluster-node-history-store.js'

const hist = (id: string, name: string, isHub = false): PersistedClusterNode => ({
  id,
  name,
  hostname: id,
  platform: 'linux',
  arch: 'x64',
  cpuModel: null,
  cpuCores: 1,
  memoryMB: 1,
  engines: [],
  isHub,
  localIps: [],
  addonIds: [],
  lastActive: 0,
})

describe('toNodeDirectory', () => {
  it('names live nodes from history, keeps offline ones, hub first', () => {
    const dir = toNodeDirectory(
      [
        { id: 'agent-b', isHub: false, isOnline: true },
        { id: 'hub', isHub: true, isOnline: true },
      ],
      [hist('hub', 'Unraid hub', true), hist('agent-b', 'Mac mini'), hist('agent-gone', 'Old NUC')],
    )
    expect(dir).toEqual({
      complete: true,
      nodes: [
        { id: 'hub', name: 'Unraid hub', isHub: true, isOnline: true },
        { id: 'agent-b', name: 'Mac mini', isHub: false, isOnline: true },
        { id: 'agent-gone', name: 'Old NUC', isHub: false, isOnline: false },
      ],
    })
  })

  it('an UNREADABLE history is incomplete: live nodes named by id, nothing claimed removed', () => {
    const dir = toNodeDirectory([{ id: 'agent-b', isHub: false, isOnline: false }], null)
    expect(dir).toEqual({
      complete: false,
      nodes: [{ id: 'agent-b', name: 'agent-b', isHub: false, isOnline: false }],
    })
  })

  it('an ANSWERED empty history is complete', () => {
    expect(toNodeDirectory([], []).complete).toBe(true)
  })

  it('a live node Moleculer marks offline stays listed and marked offline', () => {
    const dir = toNodeDirectory(
      [{ id: 'agent-c', isHub: false, isOnline: false }],
      [hist('agent-c', 'Garage Pi')],
    )
    expect(dir.nodes).toEqual([{ id: 'agent-c', name: 'Garage Pi', isHub: false, isOnline: false }])
  })

  it('an empty persisted name falls back to the id', () => {
    const dir = toNodeDirectory([], [hist('agent-x', '')])
    expect(dir.nodes).toEqual([{ id: 'agent-x', name: 'agent-x', isHub: false, isOnline: false }])
  })
})
