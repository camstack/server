import { describe, expect, it } from 'vitest'
import {
  GoogleBrokerRegistry,
  parseStampedCalendarId,
  stampCalendarId,
} from '../google-broker-registry.js'

describe('GoogleBrokerRegistry', () => {
  it('an account counts as connected only while it holds a refresh token', () => {
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
    expect(reg.isConnected('google_001')).toBe(false)

    reg.setOauth({
      id: 'google_001',
      refreshToken: 'rt',
      accessToken: 'at',
      accessExpiresAt: Date.now() + 60_000,
      accountEmail: 'a@example.com',
    })
    expect(reg.isConnected('google_001')).toBe(true)
    expect(reg.getOauth('google_001')?.accountEmail).toBe('a@example.com')

    reg.removeOauth('google_001')
    expect(reg.isConnected('google_001')).toBe(false)
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

describe('GoogleBrokerRegistry holds no calendar selection', () => {
  const form = { clientId: 'cid', clientSecret: 'sec' }

  it('an account is its credentials: the calendars it imports are calendars records', () => {
    const reg = new GoogleBrokerRegistry()
    const entry = reg.createEntry('A', form)
    expect(Object.keys(entry).toSorted()).toEqual([
      'calendarFilter',
      'clientId',
      'clientSecret',
      'fromAddress',
      'fromName',
      'id',
      'name',
    ])
  })
})
