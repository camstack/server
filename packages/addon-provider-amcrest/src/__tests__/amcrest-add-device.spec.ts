/** What "Add device" inside a amcrest integration offers is the provider's call, per instance. */
import { makeInMemoryRecords } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { buildAmcrestInstances, amcrestRecordKinds } from '../amcrest-instances.js'

describe('amcrest instances state what Add device offers', () => {
  it('serves addDevice "scan"', async () => {
    const world = makeInMemoryRecords('provider-amcrest')
    await world.records.declare(amcrestRecordKinds)
    const provider = buildAmcrestInstances(world.records).toProvider()
    await provider.createInstance({ id: 'one', name: 'One' })
    expect((await provider.listInstances({})).map((i) => i.addDevice)).toEqual(['scan'])
  })
})
