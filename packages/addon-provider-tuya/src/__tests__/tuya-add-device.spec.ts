/** What "Add device" inside a tuya integration offers is the provider's call, per instance. */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildTuyaInstances, tuyaRecordKinds } from '../tuya-instances.js'

describe('tuya instances state what Add device offers', () => {
  it('serves addDevice "children"', async () => {
    const world = makeInMemoryRecords('provider-tuya')
    await world.records.declare(tuyaRecordKinds)
    const provider = buildTuyaInstances(world.records, {
      onChanged: async () => {},
      tester: { testSettings: async () => ({ outcome: 'validated' }) },
    }).toProvider()
    await provider.createInstance({ id: 'one', name: 'One' })
    expect((await provider.listInstances({})).map((i) => i.addDevice)).toEqual(['children'])
  })
})
