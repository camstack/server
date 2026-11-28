/** What "Add device" inside a ecowitt integration offers is the provider's call, per instance. */
import { makeInMemoryRecords } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { buildEcowittInstances, ecowittRecordKinds } from '../ecowitt-instances.js'

describe('ecowitt instances state what Add device offers', () => {
  it('serves addDevice "children"', async () => {
    const world = makeInMemoryRecords('provider-ecowitt')
    await world.records.declare(ecowittRecordKinds)
    const provider = buildEcowittInstances(world.records, {
      onChanged: async () => {},
      makeProbe: () => {
        throw new Error('unused')
      },
    }).toProvider()
    await provider.createInstance({ id: 'one', name: 'One' })
    expect((await provider.listInstances({})).map((i) => i.addDevice)).toEqual(['children'])
  })
})
