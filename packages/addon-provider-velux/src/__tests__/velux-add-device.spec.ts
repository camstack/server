/** What "Add device" inside a velux integration offers is the provider's call, per instance. */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildVeluxInstances, veluxRecordKinds } from '../velux-instances.js'

describe('velux instances state what Add device offers', () => {
  it('serves addDevice "children"', async () => {
    const world = makeInMemoryRecords('provider-velux')
    await world.records.declare(veluxRecordKinds)
    const provider = buildVeluxInstances(world.records, {
      onChanged: async () => {},
      tester: { testSettings: async () => ({ outcome: 'validated' }) },
    }).toProvider()
    await provider.createInstance({ id: 'one', name: 'One' })
    expect((await provider.listInstances({})).map((i) => i.addDevice)).toEqual(['children'])
  })
})
