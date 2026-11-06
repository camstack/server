import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { haBrokersEntryKind, haConnectionsEntryKind } from '../broker-record-kinds.js'
import { rawBrokers } from './raw-brokers.js'
import { buildHaInstances } from '../ha-instances.js'

async function setup() {
  const world = makeInMemoryRecords('provider-homeassistant')
  await world.records.declare({
    brokers: haBrokersEntryKind,
    connections: haConnectionsEntryKind,
  })
  const brokers = rawBrokers(world.records)
  await brokers.put(
    {
      id: 'ha_007',
      data: {
        name: 'Home',
        authKind: 'long-lived',
        baseUrl: 'http://ha.local:8123',
        accessToken: 'tok',
        calendarIds: ['calendar.home'],
      },
    },
    { ifRev: 0 },
  )
  return { instances: buildHaInstances(world.records), brokers }
}

describe('Home Assistant integrations as integration instances', () => {
  it('creating an integration writes its record under the registry id and no broker row', async () => {
    const { instances, brokers } = await setup()
    await instances.createInstance({ id: 'int_0060', name: 'HA home' })
    expect((await instances.getInstance({ id: 'int_0060' }))?.name).toBe('HA home')
    expect(await brokers.get('int_0060')).toBeNull()
  })

  it('brings devices and its form is a connection picker with no connection field', async () => {
    const { instances } = await setup()
    expect(await instances.describe()).toMatchObject({ role: 'devices' })
    const form = await instances.instanceFormSchema({ id: null })
    expect(form.sections.flatMap((s) => s.fields.map((f) => ('key' in f ? f.key : '')))).toEqual([
      'brokerId',
    ])
  })

  it('links to a connection by id and leaves the connection record alone', async () => {
    const { instances, brokers } = await setup()
    await instances.createInstance({ id: 'int_0060', name: 'HA home' })
    await instances.updateInstance({ id: 'int_0060', values: { brokerId: 'ha_007' } })
    expect(await instances.getResolved('int_0060')).toMatchObject({ brokerId: 'ha_007' })
    expect((await brokers.getResolved('ha_007'))?.data).toMatchObject({
      baseUrl: 'http://ha.local:8123',
      accessToken: 'tok',
      calendarIds: ['calendar.home'],
    })
  })
})
