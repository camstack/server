/** What "Add device" inside a esphome integration offers is the provider's call, per instance. */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildEspInstances, espConnectionsEntryKind } from '../esphome-instances.js'

describe('esphome instances state what Add device offers', () => {
  it('serves addDevice "scan"', async () => {
    const world = makeInMemoryRecords('provider-esphome')
    await world.records.declare({ connections: espConnectionsEntryKind })
    const provider = buildEspInstances(world.records, { onChanged: async () => {} }).toProvider()
    await provider.createInstance({ id: 'one', name: 'One' })
    expect((await provider.listInstances({})).map((i) => i.addDevice)).toEqual(['scan'])
  })
})
