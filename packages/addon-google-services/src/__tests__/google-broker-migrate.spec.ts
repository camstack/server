import { describe, expect, it } from 'vitest'
import { migrateLegacyToBrokers } from '../google-broker-registry.js'
import { DEFAULT_OAUTH_STATE } from '../google-types.js'

describe('migrateLegacyToBrokers', () => {
  it('moves flat clientId + oauth refresh into google_001 and marks migrated', () => {
    const result = migrateLegacyToBrokers(
      {
        clientId: 'cid-live',
        clientSecret: 'csec-live',
        calendarFilter: 'cal-a@g',
        fromAddress: 'me@example.com',
        fromName: 'Me',
      },
      {
        ...DEFAULT_OAUTH_STATE,
        refreshToken: 'rt-live',
        accessToken: 'at-live',
        accessExpiresAt: 1_700_000_000_000,
        accountEmail: 'me@example.com',
      },
    )
    expect(result.didMigrate).toBe(true)
    expect(result.brokers).toHaveLength(1)
    const b = result.brokers[0]!
    expect(b.id).toBe('google_001')
    expect(b.clientId).toBe('cid-live')
    expect(b.clientSecret).toBe('csec-live')
    expect(b.calendarFilter).toBe('cal-a@g')
    expect(b.fromAddress).toBe('me@example.com')
    expect(b.name).toBe('me@example.com')
    expect(result.oauthAccounts).toEqual([
      {
        id: 'google_001',
        refreshToken: 'rt-live',
        accessToken: 'at-live',
        accessExpiresAt: 1_700_000_000_000,
        accountEmail: 'me@example.com',
        needsReauth: false,
      },
    ])
  })

  it('is a no-op when brokers already exist (does not invent a second google_001)', () => {
    const result = migrateLegacyToBrokers(
      {
        brokers: [
          {
            id: 'google_001',
            name: 'Existing',
            clientId: 'keep',
            clientSecret: 'keep-sec',
            calendarFilter: '',
            fromAddress: '',
            fromName: '',
          },
        ],
        clientId: 'should-ignore',
      },
      { ...DEFAULT_OAUTH_STATE, refreshToken: 'rt' },
    )
    expect(result.didMigrate).toBe(false)
    expect(result.brokers).toHaveLength(1)
    expect(result.brokers[0]!.clientId).toBe('keep')
    expect(result.oauthAccounts).toEqual([])
  })

  it('does nothing when there is neither client nor oauth', () => {
    const result = migrateLegacyToBrokers({}, null)
    expect(result.didMigrate).toBe(false)
    expect(result.brokers).toEqual([])
    expect(result.oauthAccounts).toEqual([])
  })
})
