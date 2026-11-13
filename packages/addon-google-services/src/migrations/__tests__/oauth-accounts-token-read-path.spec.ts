/**
 * After the `oauthAccounts` move (planning#480) the runtime reads the session from the account
 * record only: the addon reloads its accounts from the records, and Gmail sending and the
 * Calendar source get their access token from a refresh made with the MIGRATED refresh token.
 * The state key is gone by then, so a read path that still looked at it would find nothing.
 */
import { makeInMemoryRecords, type StoredKeyRead } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../google-oauth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../google-oauth.js')>()
  return { ...original, refreshAccessToken: vi.fn(), needsRefresh: () => true }
})

import { settingsFixture } from '../../__tests__/settings-fixture.js'
import { googleBrokersEntryKind } from '../../broker-record-kinds.js'
import { GoogleBrokerStore } from '../../google-broker-store.js'
import { createGoogleCalendarApi } from '../../google-calendar-source.js'
import { createGmailSmtpProvider } from '../../google-gmail-smtp.js'
import { refreshAccessToken } from '../../google-oauth.js'
import { GoogleServicesAddon } from '../../google-services.addon.js'
import {
  ADDON_MIGRATIONS,
  DROP_OAUTH_ACCOUNTS_STATE_ID as DROP,
  type GoogleMigrationPorts,
  OAUTH_ACCOUNTS_TO_RECORDS_ID as MOVE,
  RELEASE_OAUTH_ACCOUNTS_SECRETS_ID as RELEASE,
} from '../index.js'
import { oauthAccountsPortsOver } from '../ports.js'
import { NO_LEGACY_PORTS, NO_RECORD_PORTS } from './inert-ports.js'

const MARK_TOKEN = 'rt-marked-read-path'
const MARK_EMAIL = 'marked@example.com'
const ACCOUNT_ID = 'google_001'

/** A migrated install: the state entry moved onto its record and the state key deleted. */
async function migratedStore(): Promise<GoogleBrokerStore> {
  const world = makeInMemoryRecords('google-services')
  await world.records.declare({ brokers: googleBrokersEntryKind })
  const store = GoogleBrokerStore.of(world.records)
  await store.putOne({
    id: ACCOUNT_ID,
    name: 'Work Google',
    clientId: 'cid',
    clientSecret: 'sec',
    calendarFilter: '',
    fromAddress: '',
    fromName: '',
  })
  const fixture = settingsFixture(
    'google-services',
    ADDON_MIGRATIONS.filter((m) => [MOVE, RELEASE, DROP].includes(m.meta.id)),
    (readStored: (key: string) => Promise<StoredKeyRead>): GoogleMigrationPorts => ({
      ...NO_RECORD_PORTS,
      ...NO_LEGACY_PORTS,
      listBrokers: async () => [],
      setBrokerCalendarIds: async () => false,
      ...oauthAccountsPortsOver({
        store,
        readStored,
        warn: () => undefined,
        releaseStateSecrets: async () => {
          fixture.writeStored('oauthAccounts', { accounts: [] })
        },
      }),
    }),
    {
      oauthAccounts: {
        accounts: [
          {
            id: ACCOUNT_ID,
            refreshToken: MARK_TOKEN,
            accessToken: 'stale-access',
            accessExpiresAt: 7,
            accountEmail: MARK_EMAIL,
            needsReauth: false,
          },
        ],
      },
    },
    'keep-me',
  )
  expect(await fixture.boot()).toEqual({ failed: [], applied: [MOVE, RELEASE, DROP] })
  expect(fixture.rows()['google-services.oauthAccounts']).toBeUndefined()
  return store
}

async function bootedAddon(): Promise<GoogleServicesAddon> {
  const addon = new GoogleServicesAddon()
  Reflect.set(addon, 'brokerStore', await migratedStore())
  await Reflect.apply(Reflect.get(addon, 'reloadAccounts'), addon, [])
  return addon
}

function accessTokenOf(addon: GoogleServicesAddon): () => Promise<string> {
  return () => Reflect.apply(Reflect.get(addon, 'ensureAccessToken'), addon, [ACCOUNT_ID])
}

function bearerOf(init: RequestInit | undefined): string {
  return new Headers(init?.headers).get('Authorization') ?? ''
}

describe('google-services: the token read path after the oauthAccounts move', () => {
  beforeEach(() => {
    vi.mocked(refreshAccessToken).mockReset()
    vi.mocked(refreshAccessToken).mockResolvedValue({
      access_token: 'fresh-access',
      expires_in: 3600,
    })
  })

  it('Gmail sends with an access token refreshed from the migrated refresh token', async () => {
    const addon = await bootedAddon()
    const auth: string[] = []
    const fetchFake: typeof fetch = async (_url, init) => {
      auth.push(bearerOf(init))
      return Response.json({ id: 'msg-1' })
    }
    const smtp = createGmailSmtpProvider({
      accounts: () => [
        {
          brokerId: ACCOUNT_ID,
          accountEmail: MARK_EMAIL,
          fromAddress: '',
          fromName: '',
          connected: true,
          getAccessToken: accessTokenOf(addon),
        },
      ],
      fetch: fetchFake,
    })

    await smtp.sendEmail({ to: 'you@example.com', subject: 'Subj', text: 'Hello' })

    expect(vi.mocked(refreshAccessToken).mock.calls).toEqual([
      [{ clientId: 'cid', clientSecret: 'sec' }, MARK_TOKEN],
    ])
    expect(auth).toEqual(['Bearer fresh-access'])
  })

  it('the Calendar source lists with the same token, and the account counts as connected', async () => {
    const addon = await bootedAddon()
    const registry: unknown = Reflect.get(addon, 'registry')
    expect(
      typeof registry === 'object' && registry !== null
        ? Reflect.apply(Reflect.get(registry, 'isConnected'), registry, [ACCOUNT_ID])
        : false,
    ).toBe(true)
    const auth: string[] = []
    const fetchFake: typeof fetch = async (_url, init) => {
      auth.push(bearerOf(init))
      return Response.json({ items: [{ id: 'a@g', summary: 'Personal' }] })
    }
    const api = createGoogleCalendarApi(accessTokenOf(addon), { fetch: fetchFake })

    expect(await api.listCalendars()).toEqual([expect.objectContaining({ id: 'a@g' })])
    expect(vi.mocked(refreshAccessToken).mock.calls[0]?.[1]).toBe(MARK_TOKEN)
    expect(auth).toEqual(['Bearer fresh-access'])
  })
})
