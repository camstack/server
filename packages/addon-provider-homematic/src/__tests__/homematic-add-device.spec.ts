/** What "Add device" inside a homematic integration offers is the provider's call, per instance. */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildHomematicInstances, homematicRecordKinds } from '../homematic-instances.js'

describe('homematic instances state what Add device offers', () => {
  it('serves addDevice "children"', async () => {
    const world = makeInMemoryRecords('provider-homematic')
    await world.records.declare(homematicRecordKinds)
    const provider = buildHomematicInstances(world.records, {
      onChanged: async () => {},
      tester: { testSettings: async () => ({ outcome: 'validated' }) },
    }).toProvider()
    await provider.createInstance({ id: 'one', name: 'One' })
    expect((await provider.listInstances({})).map((i) => i.addDevice)).toEqual(['children'])
  })
})
