import { describe, expect, it } from 'vitest'
import { isSecretMarker, makeInMemoryRecords } from '@camstack/types'
import { GoogleBrokerEntrySchema } from '../google-types.js'
import { GoogleBrokerStore } from '../google-broker-store.js'
import { googleBrokersEntryKind } from '../broker-record-kinds.js'

async function makeGoogleRecords() {
  const world = makeInMemoryRecords('google-services')
  await world.records.declare({ brokers: googleBrokersEntryKind })
  return world
}

const ENTRY = GoogleBrokerEntrySchema.parse({
  id: 'google_001',
  name: 'Workspace',
  clientSecret: 'sec',
})

const SESSION = {
  refreshToken: 'rt-store-001',
  accountEmail: 'me@example.com',
  scopes: 'calendar.readonly',
  needsReauth: false,
}

describe('GoogleBrokerStore', () => {
  it('round-trips clientSecret on the brokers kind', async () => {
    const world = await makeGoogleRecords()
    const store = GoogleBrokerStore.of(world.records)
    await store.putOne(ENTRY)
    expect((await store.listResolved())[0]?.clientSecret).toBe('sec')
  })

  it('keeps the session on the record: the token as a keychain marker, resolved on read', async () => {
    const world = await makeGoogleRecords()
    const store = GoogleBrokerStore.of(world.records)
    await store.putOne(ENTRY)
    await store.saveSession('google_001', SESSION)

    const raw = world.tables.get('brokers')?.get('google_001')?.data
    expect(isSecretMarker(raw?.['refreshToken'])).toBe(true)
    expect(JSON.stringify(raw)).not.toContain(SESSION.refreshToken)
    expect((await store.loadAll()).sessions).toEqual([{ id: 'google_001', ...SESSION }])
    // The client fields are untouched by a session write.
    expect((await store.listResolved())[0]?.clientSecret).toBe('sec')
  })

  it('a session saved with no refresh token keeps the stored one; sign-out forgets it', async () => {
    const world = await makeGoogleRecords()
    const store = GoogleBrokerStore.of(world.records)
    await store.putOne(ENTRY, SESSION)
    await store.saveSession('google_001', {
      ...SESSION,
      refreshToken: '',
      needsReauth: true,
    })
    expect(await store.readSession('google_001')).toMatchObject({
      refreshToken: SESSION.refreshToken,
      needsReauth: true,
    })

    await store.clearSession('google_001')
    const after = await store.readSession('google_001')
    expect(after?.refreshToken ?? '').toBe('')
    expect(after?.accountEmail).toBe('')
    expect(world.tables.get('brokers')?.get('google_001')?.data['refreshToken']).toBeUndefined()
  })

  it('a record the keychain cannot serve keeps its entry but has no session', async () => {
    const world = await makeGoogleRecords()
    const store = GoogleBrokerStore.of(world.records)
    await store.putOne(ENTRY, SESSION)
    const marker = world.tables.get('brokers')?.get('google_001')?.data['refreshToken']
    if (!isSecretMarker(marker)) throw new Error('expected a keychain marker on the row')
    await world.secrets.delete([marker.$secret])
    const read = await store.loadAll()
    expect(read.entries.map((e) => e.id)).toEqual(['google_001'])
    expect(read.sessions).toEqual([])
    expect(read.unresolved).toEqual(['google_001'])
  })
})
