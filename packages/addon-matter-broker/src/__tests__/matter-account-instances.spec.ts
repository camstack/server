import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { matterBrokersEntryKind } from '../broker-record-kinds.js'
import { buildMatterAccountInstances } from '../matter-account-instances.js'

async function setup(status: 'connected' | 'disconnected' = 'connected') {
  const world = makeInMemoryRecords('matter-broker')
  await world.records.declare({ brokers: matterBrokersEntryKind })
  const handle = world.records.kind(matterBrokersEntryKind)
  await handle.put(
    {
      id: 'matter_003',
      data: {
        name: 'Hub fabric',
        threadDataset: '0e08aa',
        wifiSsid: 'home-net',
        wifiPassword: 'pw',
        reconcileIntervalMs: 300_000,
        integrationId: 'int-keep-me',
      },
    },
    { ifRev: 0 },
  )
  const changed: string[] = []
  const instances = buildMatterAccountInstances(world.records, {
    mintId: () => 'matter_004',
    infoOf: (id) =>
      id === 'matter_003'
        ? {
            id,
            name: 'Hub fabric',
            kind: 'matter',
            status,
            info: {},
            lastCheckedAt: 5,
            error: status === 'connected' ? null : 'controller stopped',
          }
        : null,
    onChanged: async (id) => {
      changed.push(id)
    },
  })
  return { instances, handle, changed }
}

describe('Matter fabrics as integration instances', () => {
  it('lists the existing fabric under its id, flat, with no sign-in', async () => {
    const { instances } = await setup()
    const [one] = await instances.listInstances()
    expect(one).toMatchObject({
      id: 'matter_003',
      kind: 'account',
      configured: true,
      status: { state: 'ok' },
    })
    expect(one?.formValues['wifiSsid']).toBe('home-net')
    expect(one?.formValues['wifiPassword']).not.toBe('pw')
    const description = await instances.describe()
    expect(description).toMatchObject({ allowRestoreId: true, mintsId: true })
  })

  it('an edit keeps both secrets and the integration link; create mints matter_NNN; restore keeps the old id', async () => {
    const { instances, handle, changed } = await setup()
    await instances.updateInstance({
      id: 'matter_003',
      values: { wifiSsid: 'other', wifiPassword: '', threadDataset: '' },
    })
    expect(await instances.getResolved('matter_003')).toMatchObject({
      wifiSsid: 'other',
      wifiPassword: 'pw',
      threadDataset: '0e08aa',
      integrationId: 'int-keep-me',
    })
    expect((await instances.createInstance({ name: 'Second' })).id).toBe('matter_004')
    await instances.createInstance({ id: 'matter_001', name: 'Back' })
    expect((await handle.query({ limit: 10 })).records.map((r) => r.id).sort()).toEqual([
      'matter_001',
      'matter_003',
      'matter_004',
    ])
    expect(changed).toEqual(['matter_003', 'matter_004', 'matter_001'])
  })

  it('tests a saved fabric by its live status', async () => {
    const { instances } = await setup('disconnected')
    expect((await instances.getInstance({ id: 'matter_003' }))?.status).toMatchObject({
      state: 'error',
    })
    expect(await instances.testInstance({ id: 'matter_003', values: {} })).toMatchObject({
      success: false,
    })
  })
})
