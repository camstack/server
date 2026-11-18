/** What "Add device" inside a gree integration offers is the provider's call, per instance. */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildGreeInstances, greeRecordKinds } from '../gree-instances.js'

describe('gree instances state what Add device offers', () => {
  it('serves addDevice "scan"', async () => {
    const world = makeInMemoryRecords('provider-gree')
    await world.records.declare(greeRecordKinds)
    const provider = buildGreeInstances(world.records).toProvider()
    await provider.createInstance({ id: 'one', name: 'One' })
    expect((await provider.listInstances({})).map((i) => i.addDevice)).toEqual(['scan'])
  })
})
