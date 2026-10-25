import { describe, expect, it } from 'vitest'
import {
  GoogleBrokerRegistry,
  parseStampedCalendarId,
  stampCalendarId,
} from '../google-broker-registry.js'
import { GOOGLE_BROKER_KIND } from '../google-types.js'

describe('GoogleBrokerRegistry', () => {
  it('listProviders shape: listBrokerInfos stamps kind google and connected only with refresh', () => {
    const reg = new GoogleBrokerRegistry()
    reg.seedFrom(
      [
        {
          id: 'google_001',
          name: 'A',
          clientId: 'cid',
          clientSecret: 'sec',
          calendarFilter: '',
          fromAddress: '',
          fromName: '',
        },
      ],
      [],
    )
    const disconnected = reg.listBrokerInfos('google-services')
    expect(disconnected).toHaveLength(1)
    expect(disconnected[0]!.kind).toBe(GOOGLE_BROKER_KIND)
    expect(disconnected[0]!.status).toBe('disconnected')

    reg.setOauth({
      id: 'google_001',
      refreshToken: 'rt',
      accessToken: 'at',
      accessExpiresAt: Date.now() + 60_000,
      accountEmail: 'a@example.com',
    })
    const connected = reg.listBrokerInfos('google-services')
    expect(connected[0]!.status).toBe('connected')
    expect(connected[0]!.info['accountEmail']).toBe('a@example.com')

    reg.removeOauth('google_001')
    expect(reg.listBrokerInfos('google-services')[0]!.status).toBe('disconnected')
  })

  it('allocateId progresses google_001, google_002', () => {
    const reg = new GoogleBrokerRegistry()
    expect(reg.allocateId()).toBe('google_001')
    expect(reg.allocateId()).toBe('google_002')
  })

  it('createEntry refuses foreign kind settings that omit clientId', () => {
    const reg = new GoogleBrokerRegistry()
    expect(() => reg.createEntry('x', { clientSecret: 'only' })).toThrow()
  })
})

describe('stampCalendarId', () => {
  it('round-trips brokerId and google calendar id', () => {
    const stamped = stampCalendarId('google_001', 'primary')
    expect(stamped).toBe('google_001:primary')
    expect(parseStampedCalendarId(stamped)).toEqual({
      brokerId: 'google_001',
      googleCalendarId: 'primary',
    })
  })
})
