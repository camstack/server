/** What "Add device" inside a enpal integration offers is the provider's call, per instance. */
import { makeInMemoryRecords } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { buildEnpalInstances, enpalRecordKinds } from '../enpal-instances.js'

describe('enpal instances state what Add device offers', () => {
  it('serves addDevice "children"', async () => {
    const world = makeInMemoryRecords('provider-enpal')
    await world.records.declare(enpalRecordKinds)
    const provider = buildEnpalInstances(world.records, { onChanged: async () => {} }).toProvider()
    await provider.createInstance({ id: 'one', name: 'One' })
    expect((await provider.listInstances({})).map((i) => i.addDevice)).toEqual(['children'])
  })
})
