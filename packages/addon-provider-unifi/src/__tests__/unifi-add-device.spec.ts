/** What "Add device" inside a unifi integration offers is the provider's call, per instance. */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildUnifiInstances, unifiRecordKinds } from '../unifi-instances.js'

describe('unifi instances state what Add device offers', () => {
  it('serves addDevice "children"', async () => {
    const world = makeInMemoryRecords('provider-unifi')
    await world.records.declare(unifiRecordKinds)
    const provider = buildUnifiInstances(world.records, {
      onChanged: async () => {},
      makeClient: () => {
        throw new Error('unused')
      },
      statusOf: () => null,
    }).toProvider()
    await provider.createInstance({ id: 'one', name: 'One' })
    expect((await provider.listInstances({})).map((i) => i.addDevice)).toEqual(['children'])
  })
})
