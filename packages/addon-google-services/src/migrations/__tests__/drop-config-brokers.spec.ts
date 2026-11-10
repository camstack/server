/**
 * The addon-level `brokers` setting and the singleton `oauth` state are deleted once their
 * replacement holds the data. Real SQLite for the addon settings (canonical `addon-settings`
 * layout), the real `brokers` record kind (in-memory records engine), through the production
 * port binding.
 */
import { makeInMemoryRecords, type StoredKeyRead, type RecordKindHandle } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { googleBrokersEntryKind } from '../../broker-record-kinds.js'
import { settingsFixture } from '../../__tests__/settings-fixture.js'
import {
  ADDON_MIGRATIONS,
  DROP_CONFIG_BROKERS_AND_LEGACY_OAUTH_ID as DROP,
  type GoogleMigrationPorts,
} from '../index.js'
import { calendarIdsPortsOver } from '../ports.js'
import { NO_LEGACY_PORTS, NO_RECORD_PORTS, NO_OAUTH_ACCOUNTS_PORTS } from './inert-ports.js'

type Body = Record<string, unknown>

const ENTRY = { id: 'google_001', name: 'A', clientId: 'c', clientSecret: 's' }
const TOKENLESS_OAUTH = { refreshToken: '', accessToken: '', accessExpiresAt: 0, accountEmail: '' }

async function start(stored: Record<string, unknown>, records: Record<string, Body>) {
  const world = makeInMemoryRecords('google-services')
  await world.records.declare({ brokers: googleBrokersEntryKind })
  const kind: RecordKindHandle<Body> = world.records.kind({
    name: googleBrokersEntryKind.name,
    declaration: googleBrokersEntryKind.declaration,
    schema: z.record(z.string(), z.unknown()),
  })
  for (const [id, data] of Object.entries(records)) await kind.put({ id, data })
  return settingsFixture(
    'google-services',
    ADDON_MIGRATIONS.filter((m) => m.meta.id === DROP),
    (readStored): GoogleMigrationPorts => ({
      ...calendarIdsPortsOver(kind, readStored),
      ...NO_RECORD_PORTS,
      ...NO_LEGACY_PORTS,
      ...NO_OAUTH_ACCOUNTS_PORTS,
    }),
    stored,
    'keep-me',
  )
}

describe('google-services: drop the addon-level brokers setting and the singleton oauth state', () => {
  it('deletes both keys when the broker records exist and the oauth state holds no token; neighbours survive', async () => {
    const f = await start(
      { brokers: [ENTRY], oauth: TOKENLESS_OAUTH, other: { mark: 'survive' } },
      { google_001: { name: 'A', clientId: 'c', clientSecret: 's' } },
    )
    expect(await f.boot()).toEqual({ failed: [], applied: [DROP] })
    expect(f.rows()['google-services.brokers']).toBeUndefined()
    expect(f.rows()['google-services.oauth']).toBeUndefined()
    expect(f.rows()['google-services.other']?.['value']).toEqual({ mark: 'survive' })
    expect(f.rows()['other-addon.brokers']?.['value']).toBe('keep-me')
  })

  it('keeps the brokers setting while the broker records are empty: it was never copied', async () => {
    const f = await start({ brokers: [ENTRY], oauth: TOKENLESS_OAUTH }, {})
    expect(await f.boot()).toEqual({ failed: [], applied: [DROP] })
    expect(f.rows()['google-services.brokers']?.['value']).toEqual([ENTRY])
    expect(f.rows()['google-services.oauth']).toBeUndefined()
  })

  it('keeps an oauth state that still holds a token no account holds', async () => {
    const f = await start(
      { brokers: [], oauth: { ...TOKENLESS_OAUTH, refreshToken: 'rt-only-copy' } },
      { google_001: { name: 'A' } },
    )
    await f.boot()
    expect(f.rows()['google-services.oauth']?.['value']).toMatchObject({
      refreshToken: 'rt-only-copy',
    })
    expect(f.rows()['google-services.brokers']).toBeUndefined()
  })

  it('drops an oauth state with a token once oauthAccounts holds accounts', async () => {
    const f = await start(
      {
        brokers: [],
        oauth: { ...TOKENLESS_OAUTH, refreshToken: 'rt' },
        oauthAccounts: { accounts: [{ id: 'google_001' }] },
      },
      {},
    )
    await f.boot()
    expect(f.rows()['google-services.oauth']).toBeUndefined()
    expect(f.rows()['google-services.oauthAccounts']).toBeDefined()
  })

  it('a second boot after the drop plans nothing', async () => {
    const f = await start(
      { brokers: [ENTRY], oauth: TOKENLESS_OAUTH },
      { google_001: { name: 'A' } },
    )
    await f.boot()
    expect(await f.boot()).toEqual({ failed: [], applied: [DROP] })
    expect(f.rows()['google-services.brokers']).toBeUndefined()
  })

  it('a stored brokers value that cannot be read fails the step and deletes nothing', async () => {
    const f = await start(
      { brokers: [ENTRY], oauth: TOKENLESS_OAUTH },
      { google_001: { name: 'A' } },
    )
    const unreadable = {
      ...f,
      readStored: async (): Promise<StoredKeyRead> => ({
        kind: 'unreadable',
        reason: 'store-read-failed',
      }),
    }
    const world = makeInMemoryRecords('google-services')
    await world.records.declare({ brokers: googleBrokersEntryKind })
    const kind: RecordKindHandle<Body> = world.records.kind({
      name: googleBrokersEntryKind.name,
      declaration: googleBrokersEntryKind.declaration,
      schema: z.record(z.string(), z.unknown()),
    })
    const ports = calendarIdsPortsOver(kind, unreadable.readStored)
    const plan = ADDON_MIGRATIONS.find((m) => m.meta.id === DROP)
    expect(plan?.meta.bodyKind).toBe('plan')
    await expect(
      plan !== undefined && 'plan' in plan
        ? plan.plan({
            ...ports,
            ...NO_RECORD_PORTS,
            ...NO_LEGACY_PORTS,
            ...NO_OAUTH_ACCOUNTS_PORTS,
          })
        : Promise.reject(new Error('no plan')),
    ).rejects.toThrow(/cannot be read/)
    expect(f.rows()['google-services.brokers']).toBeDefined()
  })
})
