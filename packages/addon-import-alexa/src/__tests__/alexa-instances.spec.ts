import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildAlexaInstances } from '../alexa-instances.js'
import { alexaBrokersEntryKind } from '../broker-record-kinds.js'

async function setup(status: 'connected' | 'disconnected' = 'connected') {
  const world = makeInMemoryRecords('import-alexa')
  await world.records.declare({ brokers: alexaBrokersEntryKind })
  const handle = world.records.kind(alexaBrokersEntryKind)
  await handle.put(
    {
      id: 'alexa_003',
      data: {
        name: 'Home',
        amazonDomain: 'amazon.it',
        cookie: 'cookie',
        refreshToken: '',
        macDms: 'mac',
        pollIntervalMs: 60_000,
        integrationId: 'int-keep-me',
      },
    },
    { ifRev: 0 },
  )
  const changed: string[] = []
  const instances = buildAlexaInstances(world.records, {
    mintId: () => 'alexa_004',
    infoOf: (id) =>
      id === 'alexa_003'
        ? {
            id,
            name: 'Home',
            kind: 'alexa',
            status,
            info: {},
            lastCheckedAt: 5,
            error: status === 'connected' ? null : 'expired',
          }
        : null,
    onChanged: async (id) => {
      changed.push(id)
    },
  })
  return { instances, handle, changed }
}

describe('Alexa accounts as integration instances', () => {
  it('lists the existing account under its id and maps the sign-in to the existing routes', async () => {
    const { instances } = await setup()
    const [one] = await instances.listInstances()
    expect(one).toMatchObject({
      id: 'alexa_003',
      kind: 'alexa',
      configured: true,
      status: { state: 'ok', label: 'Connected' },
    })
    expect(one?.formValues['amazonDomain']).toBe('amazon.it')
    expect(one?.formValues['cookie']).not.toBe('cookie')
    const description = await instances.describe()
    expect(description).toMatchObject({ allowRestoreId: true, mintsId: true })
    expect(description.kinds?.[0]?.signIn).toEqual({
      basePath: '/addon/import-alexa/login',
      methods: ['device-code', 'proxy'],
    })
  })

  it('an edit keeps the cookie, the macDms and the integration link; create mints alexa_NNN; restore keeps the old id', async () => {
    const { instances, handle, changed } = await setup()
    await instances.updateInstance({
      id: 'alexa_003',
      values: { amazonDomain: 'amazon.de', cookie: '' },
    })
    expect(await instances.getResolved('alexa_003')).toMatchObject({
      amazonDomain: 'amazon.de',
      cookie: 'cookie',
      macDms: 'mac',
      integrationId: 'int-keep-me',
    })
    expect((await instances.createInstance({ name: 'Second' })).id).toBe('alexa_004')
    await instances.createInstance({ id: 'alexa_001', name: 'Back' })
    expect((await handle.query({ limit: 10 })).records.map((r) => r.id).sort()).toEqual([
      'alexa_001',
      'alexa_003',
      'alexa_004',
    ])
    expect(changed).toEqual(['alexa_003', 'alexa_004', 'alexa_001'])
  })

  it('reports an expired sign-in as an error and tests a saved account by its live status', async () => {
    const { instances } = await setup('disconnected')
    expect((await instances.getInstance({ id: 'alexa_003' }))?.status).toMatchObject({
      state: 'error',
    })
    expect(await instances.testInstance({ id: 'alexa_003', values: {} })).toMatchObject({
      success: false,
    })
  })
})
