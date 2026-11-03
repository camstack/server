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

describe('GoogleBrokerRegistry calendarIds are per broker', () => {
  const form = { clientId: 'cid', clientSecret: 'sec' }

  it('a broker made now owns an empty set, never the shared one', () => {
    const reg = new GoogleBrokerRegistry()
    expect(reg.createEntry('A', form).calendarIds).toEqual([])
  })

  it('two brokers: editing one leaves the other, and an edit without calendars keeps the set', () => {
    const reg = new GoogleBrokerRegistry()
    const a = reg.createEntry('A', { ...form, calendarIds: ['google_001:marker-A'] })
    const b = reg.createEntry('B', form)
    reg.updateEntry(b.id, { ...form, calendarIds: ['google_002:marker-B'] })
    reg.updateEntry(a.id, { ...form, fromName: 'Renamed' })
    expect(reg.getEntry(a.id)?.calendarIds).toEqual(['google_001:marker-A'])
    expect(reg.getEntry(b.id)?.calendarIds).toEqual(['google_002:marker-B'])
  })
})

describe('calendarIdsOfEntry', () => {
  it('reads the legacy shared set only while the broker has none of its own', async () => {
    const { calendarIdsOfEntry } = await import('../google-broker-registry.js')
    expect([...calendarIdsOfEntry({ calendarIds: undefined }, ['s:1'])]).toEqual(['s:1'])
    expect([...calendarIdsOfEntry({ calendarIds: [] }, ['s:1'])]).toEqual([])
    expect([...calendarIdsOfEntry({ calendarIds: ['own:1'] }, ['s:1'])]).toEqual(['own:1'])
    expect([...calendarIdsOfEntry(null, ['s:1'])]).toEqual(['s:1'])
  })
})
