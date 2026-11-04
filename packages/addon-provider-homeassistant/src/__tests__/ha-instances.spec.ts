import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { haBrokersEntryKind } from '../broker-record-kinds.js'
import { buildHaInstances } from '../ha-instances.js'

async function setup() {
  const world = makeInMemoryRecords('provider-homeassistant')
  await world.records.declare({ brokers: haBrokersEntryKind })
  const handle = world.records.kind(haBrokersEntryKind)
  await handle.put(
    {
      id: 'ha_007',
      data: {
        name: 'Home',
        authKind: 'long-lived',
        baseUrl: 'http://ha.local:8123',
        accessToken: 'tok',
        integrationId: 'int-keep-me',
      },
    },
    { ifRev: 0 },
  )
  const changed: string[] = []
  let connected = true
  const instances = buildHaInstances(world.records, {
    mintId: () => 'ha_008',
    infoOf: (id) =>
      id === 'ha_007'
        ? {
            id,
            name: 'Home',
            kind: 'home-assistant',
            status: connected ? 'connected' : 'disconnected',
            info: {},
            lastCheckedAt: 5,
            error: connected ? null : 'refused',
          }
        : null,
    onChanged: async (id) => {
      changed.push(id)
    },
    probe: async () => ({ ok: false, error: 'bad token' }),
  })
  return { instances, handle, changed, drop: () => (connected = false) }
}

describe('Home Assistant connections as integration instances', () => {
  it('lists the existing broker under its id, flat, with its status', async () => {
    const { instances } = await setup()
    const [one] = await instances.listInstances()
    expect(one).toMatchObject({
      id: 'ha_007',
      kind: 'home-assistant',
      configured: true,
      status: { state: 'ok', label: 'Connected' },
    })
    expect(one?.formValues['baseUrl']).toBe('http://ha.local:8123')
    expect(JSON.stringify(one?.formValues['accessToken'])).not.toContain('tok"')
    expect(await instances.describe()).toMatchObject({ allowRestoreId: true, mintsId: true })
  })

  it('an edit keeps the token and the integration link; create mints ha_NNN, restore keeps the old id', async () => {
    const { instances, handle, changed } = await setup()
    await instances.updateInstance({
      id: 'ha_007',
      values: { baseUrl: 'http://ha2:8123', accessToken: '' },
    })
    expect(await instances.getResolved('ha_007')).toMatchObject({
      baseUrl: 'http://ha2:8123',
      accessToken: 'tok',
      integrationId: 'int-keep-me',
    })
    expect((await instances.createInstance({ name: 'Second' })).id).toBe('ha_008')
    await instances.createInstance({ id: 'ha_002', name: 'Back' })
    expect((await handle.query({ limit: 10 })).records.map((r) => r.id).sort()).toEqual([
      'ha_002',
      'ha_007',
      'ha_008',
    ])
    expect(changed).toEqual(['ha_007', 'ha_008', 'ha_002'])
  })

  it('tests a typed token with the probe, a saved connection by its live status', async () => {
    const { instances, drop } = await setup()
    expect(
      await instances.testInstance({ id: null, values: { accessToken: 'new' } }),
    ).toMatchObject({ success: false, error: 'bad token' })
    expect(await instances.testInstance({ id: 'ha_007', values: {} })).toMatchObject({
      success: true,
    })
    drop()
    expect(await instances.testInstance({ id: 'ha_007', values: {} })).toMatchObject({
      success: false,
    })
  })
})
