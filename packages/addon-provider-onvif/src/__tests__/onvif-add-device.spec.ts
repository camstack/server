/** What "Add device" inside a onvif integration offers is the provider's call, per instance. */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildOnvifInstances, onvifRecordKinds } from '../onvif-instances.js'

describe('onvif instances state what Add device offers', () => {
  it('serves addDevice "scan"', async () => {
    const world = makeInMemoryRecords('provider-onvif')
    await world.records.declare(onvifRecordKinds)
    const provider = buildOnvifInstances(world.records).toProvider()
    await provider.createInstance({ id: 'one', name: 'One' })
    expect((await provider.listInstances({})).map((i) => i.addDevice)).toEqual(['scan'])
  })
})
