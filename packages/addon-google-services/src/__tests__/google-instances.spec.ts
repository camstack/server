import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { googleBrokersEntryKind } from '../broker-record-kinds.js'
import { buildGoogleInstances, googleAccountKind } from '../google-instances.js'

async function setup(session: 'connected' | 'reauth' | 'none' = 'none') {
  const world = makeInMemoryRecords('google-services')
  await world.records.declare({ brokers: googleBrokersEntryKind })
  const handle = world.records.kind(googleBrokersEntryKind)
  // An existing broker, written the way the addon always wrote it.
  await handle.put(
    {
      id: 'google_007',
      data: {
        name: 'Home account',
        clientId: 'cid',
        clientSecret: 'sec',
        calendarFilter: 'keep-me',
        fromAddress: 'a@example.com',
        fromName: '',
        refreshToken: '',
        accountEmail: '',
        scopes: '',
        needsReauth: false,
      },
    },
    { ifRev: 0 },
  )
  let next = 8
  const changed: string[] = []
  const instances = buildGoogleInstances(world.records, {
    connectPath: '/addon/google-services/oauth/start?brokerId={{brokerId}}',
    disconnectPath: '/addon/google-services/oauth/disconnect?brokerId={{brokerId}}',
    publicOrigin: () => 'https://hub.example.com',
    mintId: () => `google_${String(next++).padStart(3, '0')}`,
    session: () => session,
    onChanged: async (id) => {
      changed.push(id)
    },
    testSaved: async () => ({ ok: true, latencyMs: 4 }),
    testClient: async () => ({ ok: false, error: 'bad client' }),
  })
  return { instances, changed, handle }
}

describe('Google accounts as integration instances', () => {
  it('lists the existing broker under its id, with its sign-in and status', async () => {
    const { instances } = await setup('connected')
    const [one] = await instances.listInstances()
    expect(one).toMatchObject({
      id: 'google_007',
      name: 'Home account',
      kind: 'google',
      configured: true,
      enabled: true,
      status: { state: 'ok', label: 'Signed in' },
    })
    expect(JSON.stringify(one?.formValues['clientSecret'])).not.toContain('sec"')
    expect(one?.formValues['fromAddress']).toBe('a@example.com')
    const description = await instances.describe()
    expect(description).toMatchObject({ allowRestoreId: true, mintsId: true })
    expect(
      googleAccountKind({ connectPath: '/c?b={{brokerId}}', disconnectPath: '/d' }),
    ).toMatchObject({
      functionCap: 'broker',
      alsoServes: ['smtp-provider'],
      brokerKind: 'google',
    })
  })

  it('reports a session that needs a new sign-in, and an account never signed in', async () => {
    expect(
      (await (await setup('reauth')).instances.getInstance({ id: 'google_007' }))?.status,
    ).toMatchObject({ state: 'error' })
    expect(
      (await (await setup('none')).instances.getInstance({ id: 'google_007' }))?.status,
    ).toMatchObject({ state: 'unknown' })
  })

  it('an edit keeps the secret and the fields the form does not carry; create mints google_NNN and restore keeps the old id', async () => {
    const { instances, handle, changed } = await setup()
    await instances.updateInstance({
      id: 'google_007',
      values: { clientId: 'cid2', clientSecret: '' },
    })
    expect(await instances.getResolved('google_007')).toMatchObject({
      clientId: 'cid2',
      clientSecret: 'sec',
      calendarFilter: 'keep-me',
    })
    const minted = await instances.createInstance({ name: 'Work' })
    expect(minted.id).toBe('google_008')
    await instances.createInstance({ id: 'google_002', name: 'Restored' })
    expect((await handle.query({ limit: 10 })).records.map((r) => r.id).sort()).toEqual([
      'google_002',
      'google_007',
      'google_008',
    ])
    expect(changed).toEqual(['google_007', 'google_008', 'google_002'])
  })

  it('tests the typed OAuth client when one is typed, the saved account otherwise', async () => {
    const { instances } = await setup()
    expect(
      await instances.testInstance({ id: null, values: { clientId: 'x', clientSecret: 'y' } }),
    ).toMatchObject({ success: false, error: 'bad client' })
    expect(await instances.testInstance({ id: 'google_007', values: {} })).toMatchObject({
      success: true,
    })
    expect(await instances.testInstance({ id: null, values: {} })).toMatchObject({ success: false })
  })
})
