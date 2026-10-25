import { describe, expect, it, vi } from 'vitest'
import {
  createGoogleCalendarSource,
  mapGoogleEvent,
  type GoogleCalendarApi,
} from '../google-calendar-source.js'

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: vi.fn(),
  error: () => undefined,
} as never

describe('mapGoogleEvent', () => {
  it('maps all-day events with exclusive end date', () => {
    const ev = mapGoogleEvent('cal1', {
      id: 'e1',
      summary: 'Holiday',
      start: { date: '2026-10-15' },
      end: { date: '2026-10-16' },
    })
    expect(ev).toMatchObject({
      id: 'e1',
      calendarId: 'cal1',
      title: 'Holiday',
      allDay: true,
      startMs: Date.parse('2026-10-15T00:00:00.000Z'),
      endMs: Date.parse('2026-10-16T00:00:00.000Z'),
    })
  })

  it('maps timed events', () => {
    const ev = mapGoogleEvent('cal1', {
      id: 'e2',
      summary: 'Meet',
      start: { dateTime: '2026-10-15T10:00:00Z' },
      end: { dateTime: '2026-10-15T11:00:00Z' },
    })
    expect(ev?.allDay).toBe(false)
    expect(ev?.startMs).toBe(Date.parse('2026-10-15T10:00:00Z'))
  })
})

describe('createGoogleCalendarSource', () => {
  function apiFor(calendars: { id: string; summary: string }[]): GoogleCalendarApi {
    return {
      listCalendars: async () => calendars,
      listEvents: async ({ calendarId }) => [
        {
          id: `${calendarId}-ev`,
          summary: 'X',
          start: { date: '2026-10-20' },
          end: { date: '2026-10-21' },
        },
      ],
    }
  }

  it('empty selection imports nothing', async () => {
    const provider = createGoogleCalendarSource({
      logger,
      selectedCalendarIds: () => new Set(),
      accounts: () => [
        {
          brokerId: 'google_001',
          connected: true,
          api: apiFor([
            { id: 'a@g', summary: 'Personal' },
            { id: 'b@g', summary: 'Work' },
          ]),
        },
      ],
    })
    expect(await provider.listCalendars()).toEqual([])
  })

  it('stamps ids and filters by selected stamped set', async () => {
    const provider = createGoogleCalendarSource({
      logger,
      selectedCalendarIds: () => new Set(['google_001:a@g']),
      accounts: () => [
        {
          brokerId: 'google_001',
          connected: true,
          api: apiFor([
            { id: 'a@g', summary: 'Personal' },
            { id: 'b@g', summary: 'Work' },
          ]),
        },
      ],
    })
    const list = await provider.listCalendars()
    expect(list).toEqual([
      { id: 'google_001:a@g', name: 'Personal', source: 'addon', enabled: true },
    ])
  })

  it('aggregates two brokers under one stamped selection', async () => {
    const provider = createGoogleCalendarSource({
      logger,
      selectedCalendarIds: () =>
        new Set(['google_001:a@g', 'google_002:c@g', 'google_002:shared@g']),
      accounts: () => [
        {
          brokerId: 'google_001',
          connected: true,
          api: apiFor([
            { id: 'a@g', summary: 'A' },
            { id: 'shared@g', summary: 'Shared-1' },
          ]),
        },
        {
          brokerId: 'google_002',
          connected: true,
          api: apiFor([
            { id: 'c@g', summary: 'C' },
            { id: 'shared@g', summary: 'Shared-2' },
          ]),
        },
      ],
    })
    const list = await provider.listCalendars()
    expect(list.map((c) => c.id).toSorted()).toEqual([
      'google_001:a@g',
      'google_002:c@g',
      'google_002:shared@g',
    ])
  })

  it('filters listEvents by intersection of request and selection', async () => {
    const provider = createGoogleCalendarSource({
      logger,
      selectedCalendarIds: () => new Set(['google_001:a@g', 'google_001:b@g']),
      accounts: () => [
        {
          brokerId: 'google_001',
          connected: true,
          api: apiFor([
            { id: 'a@g', summary: 'A' },
            { id: 'b@g', summary: 'B' },
          ]),
        },
      ],
    })
    const events = await provider.listEvents({
      calendarIds: ['google_001:b@g'],
      startMs: 0,
      endMs: Date.parse('2026-12-01'),
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.calendarId).toBe('google_001:b@g')
  })

  it('skips disconnected brokers', async () => {
    const provider = createGoogleCalendarSource({
      logger,
      selectedCalendarIds: () => new Set(['google_001:a@g']),
      accounts: () => [
        {
          brokerId: 'google_001',
          connected: false,
          api: apiFor([{ id: 'a@g', summary: 'A' }]),
        },
      ],
    })
    expect(await provider.listCalendars()).toEqual([])
  })
})
