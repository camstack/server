import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { matterBrokersEntryKind, matterConnectionsEntryKind } from '../broker-record-kinds.js'
import { buildMatterInstances } from '../matter-instances.js'

async function setup() {
  const world = makeInMemoryRecords('matter-broker')
  await world.records.declare({
    brokers: matterBrokersEntryKind,
    connections: matterConnectionsEntryKind,
  })
  const brokers = world.records.kind(matterBrokersEntryKind)
  await brokers.put(
    {
      id: 'matter_003',
      data: {
        name: 'Hub fabric',
        threadDataset: '0e08aa',
        wifiSsid: 'home-net',
        wifiPassword: 'pw',
        reconcileIntervalMs: 300_000,
      },
    },
    { ifRev: 0 },
  )
  return { instances: buildMatterInstances(world.records), brokers }
}

describe('Matter integrations as integration instances', () => {
  it('creating an integration writes its record under the registry id and no broker row', async () => {
    const { instances, brokers } = await setup()
    await instances.createInstance({ id: 'int_0040', name: 'Matter home' })
    expect((await instances.getInstance({ id: 'int_0040' }))?.name).toBe('Matter home')
    expect(await brokers.get('int_0040')).toBeNull()
  })

  it('brings devices and its form is a fabric picker with no connection field', async () => {
    const { instances } = await setup()
    expect(await instances.describe()).toMatchObject({ role: 'devices' })
    const form = await instances.instanceFormSchema({ id: null })
    expect(form.sections.flatMap((s) => s.fields.map((f) => ('key' in f ? f.key : '')))).toEqual([
      'brokerId',
    ])
  })

  it('links to a fabric by id and leaves the fabric record alone', async () => {
    const { instances, brokers } = await setup()
    await instances.createInstance({ id: 'int_0040', name: 'Matter home' })
    await instances.updateInstance({ id: 'int_0040', values: { brokerId: 'matter_003' } })
    expect(await instances.getResolved('int_0040')).toMatchObject({ brokerId: 'matter_003' })
    expect((await brokers.getResolved('matter_003'))?.data).toMatchObject({
      wifiSsid: 'home-net',
      wifiPassword: 'pw',
    })
  })
})
