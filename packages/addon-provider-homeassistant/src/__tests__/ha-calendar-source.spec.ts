import { describe, expect, it, vi } from 'vitest'
import {
  createHaCalendarSource,
  extractEvents,
  formatHaError,
  mapEvent,
  parseHaDate,
} from '../ha-calendar-source.js'
import type { PublishTargetHa } from '../ha-integration-manager.js'

describe('parseHaDate', () => {
  it('parses all-day, ISO, and HA space-separated datetimes', () => {
    expect(parseHaDate('2024-03-10')).toBe(Date.UTC(2024, 2, 10))
    expect(parseHaDate('2024-03-10T19:00:00+00:00')).toBe(Date.parse('2024-03-10T19:00:00+00:00'))
    expect(parseHaDate('2024-03-10 19:00:00')).toBe(Date.parse('2024-03-10T19:00:00'))
  })

  it('rejects empty / non-string', () => {
    expect(parseHaDate('')).toBeNull()
    expect(parseHaDate(null)).toBeNull()
  })
})

describe('mapEvent all-day', () => {
  it('keeps a one-day event as UTC midnight to the next UTC midnight (exclusive end)', () => {
    const ev = mapEvent('calendar.a', { start: '2026-10-15', end: '2026-10-16', summary: 'x' }, 0)
    expect(ev?.startMs).toBe(Date.UTC(2026, 9, 15))
    expect(ev?.endMs).toBe(Date.UTC(2026, 9, 16))
    expect(ev?.allDay).toBe(true)
  })
})

describe('extractEvents', () => {
  it('reads get_events response keyed by entity id', () => {
    const result = {
      response: {
        'calendar.work': {
          events: [
            { summary: 'Standup', start: '2024-03-10T09:00:00Z', end: '2024-03-10T09:15:00Z' },
          ],
        },
        'calendar.home': {
          events: [
            { summary: 'Dinner', start: '2024-03-10T19:00:00Z', end: '2024-03-10T20:00:00Z' },
          ],
        },
      },
    }
    expect(extractEvents(result, 'calendar.work')).toHaveLength(1)
    expect(extractEvents(result, 'calendar.work')[0]?.['summary']).toBe('Standup')
    expect(extractEvents(result, 'calendar.missing')).toEqual([])
  })

  it('does not steal another calendar when the key is present but empty', () => {
    const result = {
      response: {
        'calendar.work': { events: [] },
        'calendar.home': {
          events: [
            { summary: 'Dinner', start: '2024-03-10T19:00:00Z', end: '2024-03-10T20:00:00Z' },
          ],
        },
      },
    }
    expect(extractEvents(result, 'calendar.work')).toEqual([])
  })
})

describe('mapEvent', () => {
  it('maps string start/end from get_events', () => {
    const ev = mapEvent(
      'calendar.work',
      { summary: 'Standup', start: '2024-03-10T09:00:00Z', end: '2024-03-10T09:15:00Z' },
      0,
    )
    expect(ev?.title).toBe('Standup')
    expect(ev?.startMs).toBe(Date.parse('2024-03-10T09:00:00Z'))
    expect(ev?.calendarId).toBe('calendar.work')
  })

  it('maps nested dateTime objects (legacy shape)', () => {
    const ev = mapEvent(
      'calendar.work',
      {
        summary: 'Legacy',
        start: { dateTime: '2024-03-10T09:00:00Z' },
        end: { dateTime: '2024-03-10T10:00:00Z' },
      },
      0,
    )
    expect(ev?.title).toBe('Legacy')
  })
})

describe('formatHaError', () => {
  it('stringifies HA plain-object rejections', () => {
    expect(formatHaError({ code: 'unknown_service', message: 'Service not found.' })).toBe(
      'unknown_service: Service not found.',
    )
    expect(formatHaError(new Error('boom'))).toBe('boom')
  })
})

describe('createHaCalendarSource listEvents', () => {
  it('calls calendar.get_events once for all entity ids', async () => {
    const publish = vi.fn(async (_target: PublishTargetHa, _payload: unknown) => ({
      response: {
        'calendar.a': {
          events: [{ summary: 'A', start: '2024-03-10T09:00:00Z', end: '2024-03-10T10:00:00Z' }],
        },
        'calendar.b': {
          events: [{ summary: 'B', start: '2024-03-10T11:00:00Z', end: '2024-03-10T12:00:00Z' }],
        },
      },
    }))
    const source = createHaCalendarSource({
      brokers: {
        listManagers: () => [
          {
            brokerId: 'ha_001',
            manager: {
              snapshotAllStates: () => ({
                'calendar.a': {
                  entity_id: 'calendar.a',
                  state: 'off',
                  attributes: {},
                  last_changed: '',
                  last_updated: '',
                  context: { id: 'x', parent_id: null, user_id: null },
                },
                'calendar.b': {
                  entity_id: 'calendar.b',
                  state: 'unavailable',
                  attributes: {},
                  last_changed: '',
                  last_updated: '',
                  context: { id: 'y', parent_id: null, user_id: null },
                },
                'sensor.x': {
                  entity_id: 'sensor.x',
                  state: '1',
                  attributes: {},
                  last_changed: '',
                  last_updated: '',
                  context: { id: 'z', parent_id: null, user_id: null },
                },
              }),
              publish,
            },
          },
        ],
      } as never,
      selectedCalendarIds: () => new Set(['calendar.a', 'calendar.b']),
      logger: { warn: vi.fn(), child: vi.fn() } as never,
    })

    const events = await source.listEvents({
      startMs: Date.parse('2024-03-01T00:00:00Z'),
      endMs: Date.parse('2024-03-31T00:00:00Z'),
    })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      domain: 'calendar',
      service: 'get_events',
      returnResponse: true,
    })
    expect(publish.mock.calls[0]?.[0]?.entityId).toEqual(['calendar.a', 'calendar.b'])
    expect(events.map((e) => e.title).sort()).toEqual(['A', 'B'])
  })
})
