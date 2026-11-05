import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildAlexaInstances } from '../alexa-instances.js'
import { alexaBrokersEntryKind, alexaConnectionsEntryKind } from '../broker-record-kinds.js'

async function setup() {
  const world = makeInMemoryRecords('import-alexa')
  await world.records.declare({
    brokers: alexaBrokersEntryKind,
    connections: alexaConnectionsEntryKind,
  })
  const brokers = world.records.kind(alexaBrokersEntryKind)
  await brokers.put(
    {
      id: 'alexa_002',
      data: {
        name: 'Home',
        amazonDomain: 'amazon.it',
        cookie: 'cookie',
        refreshToken: 'refresh',
        macDms: 'mac',
        pollIntervalMs: 60_000,
      },
    },
    { ifRev: 0 },
  )
  return {
    instances: buildAlexaInstances(world.records),
    brokers,
    connections: world.records.kind(alexaConnectionsEntryKind),
  }
}

describe('Alexa integrations as integration instances', () => {
  it('creating an integration writes ITS record under the registry id and no broker row', async () => {
    const { instances, brokers, connections } = await setup()
    await instances.createInstance({ id: 'int_0036', name: 'Alexa home' })
    expect((await connections.get('int_0036'))?.data.name).toBe('Alexa home')
    expect(await brokers.get('int_0036')).toBeNull()
    expect((await brokers.query({ limit: 10 })).records.map((r) => r.id)).toEqual(['alexa_002'])
  })

  it('is an integration that brings devices and its form is a broker picker, no connection fields', async () => {
    const { instances } = await setup()
    expect(await instances.describe()).toMatchObject({ role: 'devices' })
    const form = await instances.instanceFormSchema({ id: null })
    const keys = form.sections.flatMap((s) => s.fields.map((f) => ('key' in f ? f.key : '')))
    expect(keys).toEqual(['brokerId'])
    expect(form.sections[0]?.fields[0]).toMatchObject({
      type: 'broker-select',
      brokerKind: 'alexa',
    })
  })

  it('links to a broker by id and never touches the broker record', async () => {
    const { instances, brokers } = await setup()
    await instances.createInstance({ id: 'int_0036', name: 'Alexa home' })
    expect((await instances.listInstances())[0]).toMatchObject({ configured: false })
    await instances.updateInstance({ id: 'int_0036', values: { brokerId: 'alexa_002' } })
    expect(await instances.getResolved('int_0036')).toMatchObject({ brokerId: 'alexa_002' })
    expect((await instances.listInstances())[0]).toMatchObject({ configured: true })
    expect(await brokers.getResolved('alexa_002')).toMatchObject({
      data: { cookie: 'cookie', macDms: 'mac' },
    })
  })
})
