/** What "Add device" inside a wyze integration offers is the provider's call, per instance. */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildWyzeInstances, wyzeRecordKinds } from '../wyze-instances.js'

describe('wyze instances state what Add device offers', () => {
  it('serves addDevice "children"', async () => {
    const world = makeInMemoryRecords('provider-wyze')
    await world.records.declare(wyzeRecordKinds)
    const provider = buildWyzeInstances(world.records, {
      onChanged: async () => {},
      tester: { testSettings: async () => ({ outcome: 'validated' }) },
    }).toProvider()
    await provider.createInstance({ id: 'one', name: 'One' })
    expect((await provider.listInstances({})).map((i) => i.addDevice)).toEqual(['children'])
  })
})
