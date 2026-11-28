/** What "Add device" inside a unraid integration offers is the provider's call, per instance. */
import { makeInMemoryRecords } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { buildUnraidInstances, unraidRecordKinds } from '../unraid-instances.js'

describe('unraid instances state what Add device offers', () => {
  it('serves addDevice "children"', async () => {
    const world = makeInMemoryRecords('provider-unraid')
    await world.records.declare(unraidRecordKinds)
    const provider = buildUnraidInstances(world.records, {
      onChanged: async () => {},
      makeClient: () => {
        throw new Error('unused')
      },
    }).toProvider()
    await provider.createInstance({ id: 'one', name: 'One' })
    expect((await provider.listInstances({})).map((i) => i.addDevice)).toEqual(['children'])
  })
})
