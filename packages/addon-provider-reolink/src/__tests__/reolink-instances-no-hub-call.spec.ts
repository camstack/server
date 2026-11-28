/**
 * The hub's `integrations.get` projects the switches by calling this provider's `listInstances`,
 * so `listInstances` asking the hub for evidence is an unbounded call cycle. The request path
 * reads the addon's cache only.
 */
import { makeInMemoryRecords } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import {
  buildReolinkInstances,
  ReolinkEvidenceCache,
  type ReolinkRegistryEvidence,
  reolinkInstancesProvider,
  reolinkRecordKinds,
} from '../reolink-instances.js'

describe('reolink instances provider: request path never asks the hub', () => {
  it('listInstances and getInstance answer from the cache, with zero hub lookups', async () => {
    const world = makeInMemoryRecords('provider-reolink')
    await world.records.declare(reolinkRecordKinds)
    const evidenceCache = new ReolinkEvidenceCache()
    evidenceCache.set('hub-1', { originStableId: 'reolink-hub-1', info: {} })

    let hubCalls = 0
    let listAgain: (() => Promise<unknown>) | null = null
    const registryEvidenceOf = async (): Promise<ReolinkRegistryEvidence | null> => {
      hubCalls += 1
      // The hub's projectSwitches calls listInstances again: the cycle, bounded here.
      if (hubCalls < 50 && listAgain !== null) await listAgain()
      return null
    }
    const deps = {
      onChanged: async () => {},
      registryEvidenceOf,
      makeHubProbe: () => {
        throw new Error('unused')
      },
    }
    const provider = reolinkInstancesProvider(buildReolinkInstances(world.records, deps), {
      registryEvidenceOf,
      evidenceCache,
    })
    await provider.createInstance({ id: 'hub-1', name: 'hub-1' })
    await provider.createInstance({ id: 'plain', name: 'plain' })
    hubCalls = 0
    listAgain = () => provider.listInstances({})

    const listed = await provider.listInstances({})
    expect(listed.map((i) => [i.id, i.addDevice])).toEqual([
      ['hub-1', 'children'],
      ['plain', 'scan'],
    ])
    expect((await provider.getInstance({ id: 'hub-1' }))?.addDevice).toBe('children')
    expect(hubCalls).toBe(0)
  })
})
