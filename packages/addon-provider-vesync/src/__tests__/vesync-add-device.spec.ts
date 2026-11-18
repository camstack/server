/** What "Add device" inside a vesync integration offers is the provider's call, per instance. */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildVeSyncInstances, vesyncRecordKinds } from '../vesync-instances.js'

describe('vesync instances state what Add device offers', () => {
  it('serves addDevice "children"', async () => {
    const world = makeInMemoryRecords('provider-vesync')
    await world.records.declare(vesyncRecordKinds)
    const provider = buildVeSyncInstances(world.records, { onChanged: async () => {} }).toProvider()
    await provider.createInstance({ id: 'one', name: 'One' })
    expect((await provider.listInstances({})).map((i) => i.addDevice)).toEqual(['children'])
  })
})
