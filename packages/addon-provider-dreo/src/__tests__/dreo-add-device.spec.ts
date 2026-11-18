/** What "Add device" inside a dreo integration offers is the provider's call, per instance. */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildDreoInstances, dreoRecordKinds } from '../dreo-instances.js'

describe('dreo instances state what Add device offers', () => {
  it('serves addDevice "children"', async () => {
    const world = makeInMemoryRecords('provider-dreo')
    await world.records.declare(dreoRecordKinds)
    const provider = buildDreoInstances(world.records, {
      onChanged: async () => {},
      tester: { testSettings: async () => ({ outcome: 'validated' }) },
    }).toProvider()
    await provider.createInstance({ id: 'one', name: 'One' })
    expect((await provider.listInstances({})).map((i) => i.addDevice)).toEqual(['children'])
  })
})
