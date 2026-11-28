/** What "Add device" inside a Kia integration offers is the provider's call, per instance. */
import { makeInMemoryRecords } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { buildKiaInstances, kiaRecordKinds } from '../kia-instances.js'

describe('kia instances state what Add device offers', () => {
  it('serves addDevice "children"', async () => {
    const world = makeInMemoryRecords('provider-kia')
    await world.records.declare(kiaRecordKinds)
    const provider = buildKiaInstances(world.records, {
      onChanged: async () => {},
      tester: { testSettings: async () => ({ outcome: 'validated' }) },
    }).toProvider()
    await provider.createInstance({ id: 'one', name: 'One' })
    expect((await provider.listInstances({})).map((i) => i.addDevice)).toEqual(['children'])
  })
})
