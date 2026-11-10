/**
 * The `oauthAccounts` state moves onto the account records (planning#480): each entry becomes or
 * joins its `brokers` record, the refresh token goes through the records door to the keychain,
 * and the state key is deleted only after a second read shows every token on its record.
 * Real SQLite for the settings table, the real `brokers` kind with its keychain.
 */
import { isSecretMarker, makeInMemoryRecords, type StoredKeyRead } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { googleBrokersEntryKind } from '../../broker-record-kinds.js'
import { GoogleBrokerStore } from '../../google-broker-store.js'
import { type SettingsFixture, settingsFixture } from '../../__tests__/settings-fixture.js'
import {
  ADDON_MIGRATIONS,
  DROP_OAUTH_ACCOUNTS_STATE_ID as DROP,
  type GoogleMigrationPorts,
  OAUTH_ACCOUNTS_TO_RECORDS_ID as MOVE,
} from '../index.js'
import { NO_LEGACY_PORTS, NO_RECORD_PORTS } from './inert-ports.js'
import { oauthAccountsPortsOver } from '../ports.js'

const MARK_TOKEN = 'rt-marked-001'
const MARK_EMAIL = 'marked@example.com'

function account(id: string, refreshToken: unknown, accountEmail = '', needsReauth = false) {
  return {
    id,
    refreshToken,
    accessToken: 'at',
    accessExpiresAt: 7,
    accountEmail,
    needsReauth,
  }
}

async function start(stored: Record<string, unknown>, existing: readonly string[] = []) {
  const world = makeInMemoryRecords('google-services')
  await world.records.declare({ brokers: googleBrokersEntryKind })
  const store = GoogleBrokerStore.of(world.records)
  for (const id of existing) {
    await store.putOne({
      id,
      name: id,
      clientId: `client-${id}`,
      clientSecret: `secret-${id}`,
      calendarFilter: '',
      fromAddress: '',
      fromName: '',
    })
  }
  const warnings: string[] = []
  const released: string[] = []
  const fixture: SettingsFixture = settingsFixture(
    'google-services',
    ADDON_MIGRATIONS.filter((m) => m.meta.id === MOVE || m.meta.id === DROP),
    (readStored: (key: string) => Promise<StoredKeyRead>): GoogleMigrationPorts => ({
      ...NO_RECORD_PORTS,
      ...NO_LEGACY_PORTS,
      listBrokers: async () => [],
      setBrokerCalendarIds: async () => false,
      ...oauthAccountsPortsOver({
        store,
        readStored,
        warn: (message) => warnings.push(message),
        releaseStateSecrets: async () => {
          released.push('oauthAccounts')
          fixture.writeStored('oauthAccounts', { accounts: [] })
        },
      }),
    }),
    stored,
    'keep-me',
  )
  const storedRow = (id: string) => world.tables.get('brokers')?.get(id)
  return { world, store, fixture, warnings, released, storedRow }
}

describe('google-services: oauthAccounts move onto the account records', () => {
  it('a marked account keeps its refresh token (as a keychain marker) and email; the state goes', async () => {
    const { store, fixture, storedRow, released } = await start(
      {
        oauthAccounts: {
          accounts: [account('google_001', MARK_TOKEN, MARK_EMAIL)],
        },
      },
      ['google_001'],
    )
    expect(await fixture.boot()).toEqual({ failed: [], applied: [MOVE, DROP] })

    // As stored: the row holds a keychain MARKER, never the token.
    const raw = storedRow('google_001')?.data
    expect(isSecretMarker(raw?.['refreshToken'])).toBe(true)
    expect(JSON.stringify(raw)).not.toContain(MARK_TOKEN)
    // Resolved through the records door: the same token, the same email, the client untouched.
    const { sessions, entries } = await store.loadAll()
    expect(sessions).toEqual([
      expect.objectContaining({
        id: 'google_001',
        refreshToken: MARK_TOKEN,
        accountEmail: MARK_EMAIL,
        needsReauth: false,
      }),
    ])
    expect(entries[0]?.clientSecret).toBe('secret-google_001')
    expect(released).toEqual(['oauthAccounts'])
    expect(fixture.rows()['google-services.oauthAccounts']).toBeUndefined()
    expect(fixture.rows()['other-addon.oauthAccounts']?.['value']).toBe('keep-me')
  })

  it('a rerun is a no-op: nothing planned, nothing rewritten', async () => {
    const { fixture, storedRow } = await start(
      {
        oauthAccounts: {
          accounts: [account('google_001', MARK_TOKEN, MARK_EMAIL)],
        },
      },
      ['google_001'],
    )
    await fixture.boot()
    const rev = storedRow('google_001')?.rev
    expect(await fixture.boot()).toEqual({ failed: [], applied: [MOVE, DROP] })
    expect(storedRow('google_001')?.rev).toBe(rev)
  })

  it('a failed entry blocks only itself: the others land, the state stays, the reason is logged', async () => {
    const locked = { $secret: 'secret://google-services/x/y', v: 1 }
    const { store, fixture, warnings, released } = await start(
      {
        oauthAccounts: {
          accounts: [account('google_001', locked), account('google_002', 'rt-two', 'two@x.io')],
        },
      },
      ['google_001', 'google_002'],
    )
    const report = await fixture.boot()
    expect(report.failed).toContain(MOVE)
    expect(report.applied).not.toContain(DROP)
    const sessions = (await store.loadAll()).sessions
    expect(sessions.find((s) => s.id === 'google_002')?.refreshToken).toBe('rt-two')
    expect(sessions.find((s) => s.id === 'google_001')?.refreshToken ?? '').toBe('')
    expect(fixture.rows()['google-services.oauthAccounts']).toBeDefined()
    expect(released).toEqual([])
    expect(warnings.some((w) => w.includes('google_001') && w.includes('keychain'))).toBe(true)
  })

  it('an entry with no record becomes one, named after its email', async () => {
    const { store, fixture } = await start({
      oauthAccounts: {
        accounts: [account('google_004', MARK_TOKEN, MARK_EMAIL)],
      },
    })
    await fixture.boot()
    const { entries, sessions } = await store.loadAll()
    expect(entries.map((e) => [e.id, e.name])).toEqual([['google_004', MARK_EMAIL]])
    expect(sessions[0]?.refreshToken).toBe(MARK_TOKEN)
  })

  it('a record that already holds a token keeps it; a refused token keeps needsReauth', async () => {
    const { store, fixture } = await start(
      {
        oauthAccounts: {
          accounts: [
            account('google_001', 'rt-old'),
            account('google_002', 'rt-dead', 'dead@x.io', true),
          ],
        },
      },
      ['google_001', 'google_002'],
    )
    await store.saveSession('google_001', {
      refreshToken: 'rt-new',
      accountEmail: 'new@x.io',
      scopes: '',
      needsReauth: false,
    })
    expect((await fixture.boot()).failed).toEqual([])
    const sessions = (await store.loadAll()).sessions
    expect(sessions.find((s) => s.id === 'google_001')).toMatchObject({
      refreshToken: 'rt-new',
      accountEmail: 'new@x.io',
    })
    expect(sessions.find((s) => s.id === 'google_002')).toMatchObject({
      refreshToken: 'rt-dead',
      needsReauth: true,
    })
  })

  it('never prints a token in a failure', async () => {
    const { world, fixture, warnings } = await start(
      { oauthAccounts: { accounts: [account('google_001', 'rt-secret-xyz')] } },
      ['google_001'],
    )
    world.failWrites(true)
    const report = await fixture.boot()
    expect(report.failed).toContain(MOVE)
    expect(report.applied).not.toContain(DROP)
    expect(warnings.join('\n')).not.toContain('rt-secret-xyz')
    expect(fixture.rows()['google-services.oauthAccounts']).toBeDefined()
  })
})
