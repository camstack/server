/**
 * The legacy addon-level accounts (the `brokers` setting, the flat singleton client, the `oauth`
 * token) become broker records and an `oauthAccounts` entry before the drop migration may delete
 * them. Real SQLite for the settings table, the real `brokers` record kind, secrets read back.
 */
import {
  makeInMemoryRecords,
  type CalendarRecordPorts,
  type RecordKindHandle,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { googleBrokersEntryKind } from '../../broker-record-kinds.js'
import { GoogleBrokerStore } from '../../google-broker-store.js'
import type { GoogleOauthAccount } from '../../google-types.js'
import { settingsFixture } from '../../__tests__/settings-fixture.js'
import {
  ADDON_MIGRATIONS,
  DROP_CONFIG_BROKERS_AND_LEGACY_OAUTH_ID as DROP,
  LEGACY_BROKERS_TO_RECORDS_ID as COPY,
  type GoogleMigrationPorts,
} from '../index.js'
import { leftoverLegacyKeys } from '../legacy-brokers-to-records.js'
import { calendarIdsPortsOver } from '../ports.js'

const NO_RECORD_PORTS: CalendarRecordPorts = {
  warn: () => undefined,
  listAccounts: async () => [],
  readCalendar: async () => null,
  putCalendar: async () => undefined,
  clearCalendarIds: async () => undefined,
}
type Body = Record<string, unknown>

async function start(stored: Record<string, unknown>, existing: readonly string[] = []) {
  const world = makeInMemoryRecords('google-services')
  await world.records.declare({ brokers: googleBrokersEntryKind })
  const raw: RecordKindHandle<Body> = world.records.kind({
    name: googleBrokersEntryKind.name,
    declaration: googleBrokersEntryKind.declaration,
    schema: z.record(z.string(), z.unknown()),
  })
  const store = GoogleBrokerStore.of(world.records)
  for (const id of existing) {
    await store.putOne({
      id,
      name: id,
      clientId: 'kept-client',
      clientSecret: 'kept-secret',
      calendarFilter: '',
      fromAddress: '',
      fromName: '',
    })
  }
  const accounts: GoogleOauthAccount[] = []
  const ports = (readStored: Parameters<typeof calendarIdsPortsOver>[1]): GoogleMigrationPorts => ({
    ...calendarIdsPortsOver(raw, readStored),
    ...NO_RECORD_PORTS,
    putBroker: (entry) => store.putOne(entry),
    readBroker: async (id) => (await store.listResolved()).find((b) => b.id === id) ?? null,
    listOauthAccountIds: async () => accounts.map((a) => a.id),
    putOauthAccount: async (account) => {
      accounts.push(account)
    },
    readOauthAccount: async (id) => accounts.find((a) => a.id === id) ?? null,
  })
  const fixture = await settingsFixture(
    'google-services',
    ADDON_MIGRATIONS.filter((m) => m.meta.id === COPY || m.meta.id === DROP),
    ports,
    stored,
    'keep-me',
  )
  return { fixture, store, accounts, ports }
}

const OAUTH = {
  refreshToken: 'rt-1',
  accessToken: 'at-1',
  accessExpiresAt: 9,
  accountEmail: 'me@x.io',
}

describe('google-services: legacy accounts move into records before the drop', () => {
  it('a flat-client hub gets one google_001 record with its secret, its oauth account, and loses the keys', async () => {
    const { fixture, store, accounts } = await start({
      clientId: 'cid',
      clientSecret: 'csecret',
      fromAddress: 'me@x.io',
      oauth: OAUTH,
      // In production the oauthAccounts handle writes this row; the fake account store does not.
      oauthAccounts: { accounts: [{ id: 'google_001' }] },
      other: { mark: 'survive' },
    })
    expect(await fixture.boot()).toEqual({ failed: [], applied: [COPY, DROP] })
    const [broker] = await store.listResolved()
    expect(broker).toMatchObject({
      id: 'google_001',
      name: 'me@x.io',
      clientId: 'cid',
      clientSecret: 'csecret',
      fromAddress: 'me@x.io',
    })
    expect(accounts).toEqual([expect.objectContaining({ id: 'google_001', refreshToken: 'rt-1' })])
    for (const key of ['clientId', 'clientSecret', 'oauth']) {
      expect(fixture.rows()[`google-services.${key}`]).toBeUndefined()
    }
    expect(fixture.rows()['google-services.other']?.['value']).toEqual({ mark: 'survive' })
  })

  it('a brokers-setting hub copies every entry, and gives the legacy token to the first', async () => {
    const entry = (id: string) => ({ id, name: id, clientId: `c-${id}`, clientSecret: `s-${id}` })
    const { fixture, store, accounts } = await start({
      brokers: [entry('google_001'), entry('google_002')],
      oauth: OAUTH,
    })
    await fixture.boot()
    expect((await store.listResolved()).map((b) => [b.id, b.clientSecret])).toEqual([
      ['google_001', 's-google_001'],
      ['google_002', 's-google_002'],
    ])
    expect(accounts.map((a) => a.id)).toEqual(['google_001'])
    expect(fixture.rows()['google-services.brokers']).toBeUndefined()
  })

  it('an already-migrated hub is unchanged: its record and secret are never overwritten', async () => {
    const { fixture, store, accounts } = await start(
      { brokers: [{ id: 'google_001', name: 'old', clientId: 'stale', clientSecret: 'stale' }] },
      ['google_001'],
    )
    await fixture.boot()
    expect((await store.listResolved())[0]).toMatchObject({
      clientId: 'kept-client',
      clientSecret: 'kept-secret',
    })
    expect(accounts).toEqual([])
    expect(fixture.rows()['google-services.brokers']).toBeUndefined()
  })

  it('a secret the keychain could not serve refuses the copy and the drop keeps the legacy keys', async () => {
    const { fixture, store } = await start({
      clientId: 'cid',
      clientSecret: { $secret: 'unavailable' },
    })
    const result = await fixture.boot()
    expect(result.applied).not.toContain(COPY)
    expect(await store.listResolved()).toEqual([])
    expect(fixture.rows()['google-services.clientId']).toBeDefined()
    expect(fixture.rows()['google-services.clientSecret']).toBeDefined()
  })

  it('leftoverLegacyKeys names what no record holds', async () => {
    const { ports } = await start({})
    const read = async (key: string) =>
      key === 'clientId'
        ? ({ kind: 'present', value: 'cid' } as const)
        : key === 'oauth'
          ? ({ kind: 'present', value: OAUTH } as const)
          : ({ kind: 'absent' } as const)
    expect(await leftoverLegacyKeys({ ...ports(read), readStored: read })).toEqual([
      'clientId',
      'oauth',
    ])
  })
})
