/** What "Add device" inside a hikvision integration offers is the provider's call, per instance. */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildHikvisionInstances, hikvisionRecordKinds } from '../hikvision-instances.js'

describe('hikvision instances state what Add device offers', () => {
  it('serves addDevice "scan"', async () => {
    const world = makeInMemoryRecords('provider-hikvision')
    await world.records.declare(hikvisionRecordKinds)
    const provider = buildHikvisionInstances(world.records).toProvider()
    await provider.createInstance({ id: 'one', name: 'One' })
    expect((await provider.listInstances({})).map((i) => i.addDevice)).toEqual(['scan'])
  })
})
