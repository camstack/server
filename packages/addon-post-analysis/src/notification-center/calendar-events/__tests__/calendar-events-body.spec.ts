import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from '@camstack/types'
import { NcTextCatalog } from '../../text-catalog.js'
import {
  CALENDAR_EVENTS_DAY_DELIMITER,
  CALENDAR_EVENTS_TOMORROW_MARK,
  formatCalendarEventsBody,
  localDayKey,
} from '../calendar-events-body.js'

function ev(
  partial: Pick<CalendarEvent, 'id' | 'title' | 'startMs' | 'endMs'> & Partial<CalendarEvent>,
): CalendarEvent {
  return {
    calendarId: 'cal',
    ...partial,
  }
}

const EN = new NcTextCatalog({ language: 'en' })
const IT = new NcTextCatalog({ language: 'it' })

describe('formatCalendarEventsBody', () => {
  // Fixed local morning: 2024-03-10 07:00 in the host timezone.
  const now = new Date(2024, 2, 10, 7, 0, 0, 0).getTime()
  const todayStart = new Date(2024, 2, 10).getTime()
  const tomorrowStart = new Date(2024, 2, 11).getTime()
  const laterStart = new Date(2024, 2, 12).getTime()

  it('puts tomorrow first with a mark, then a delimiter, then later days', () => {
    const body = formatCalendarEventsBody(
      EN,
      [
        ev({
          id: 'later',
          title: 'Dentist',
          startMs: laterStart + 10 * 60 * 60 * 1000,
          endMs: laterStart + 11 * 60 * 60 * 1000,
        }),
        ev({
          id: 'tom',
          title: 'Trash',
          startMs: Date.UTC(2024, 2, 11),
          endMs: Date.UTC(2024, 2, 12),
          allDay: true,
        }),
      ],
      now,
      7,
    )
    expect(body).toContain(`${CALENDAR_EVENTS_TOMORROW_MARK} Tomorrow`)
    expect(body).toContain('Trash')
    expect(body).toContain(CALENDAR_EVENTS_DAY_DELIMITER)
    expect(body.indexOf('Trash')).toBeLessThan(body.indexOf(CALENDAR_EVENTS_DAY_DELIMITER))
    expect(body.indexOf(CALENDAR_EVENTS_DAY_DELIMITER)).toBeLessThan(body.indexOf('Dentist'))
  })

  it('keeps today in the lead block before the delimiter', () => {
    const body = formatCalendarEventsBody(
      EN,
      [
        ev({
          id: 'today',
          title: 'Call',
          startMs: todayStart + 18 * 60 * 60 * 1000,
          endMs: todayStart + 19 * 60 * 60 * 1000,
        }),
        ev({
          id: 'tom',
          title: 'School',
          startMs: tomorrowStart + 8 * 60 * 60 * 1000,
          endMs: tomorrowStart + 9 * 60 * 60 * 1000,
        }),
        ev({
          id: 'wed',
          title: 'Shop',
          startMs: laterStart + 12 * 60 * 60 * 1000,
          endMs: laterStart + 13 * 60 * 60 * 1000,
        }),
      ],
      now,
      7,
    )
    expect(body).toContain('Today')
    expect(body.indexOf('Call')).toBeLessThan(body.indexOf('School'))
    expect(body.indexOf('School')).toBeLessThan(body.indexOf(CALENDAR_EVENTS_DAY_DELIMITER))
    expect(body.indexOf(CALENDAR_EVENTS_DAY_DELIMITER)).toBeLessThan(body.indexOf('Shop'))
  })

  it('omits the delimiter when only tomorrow has events', () => {
    const body = formatCalendarEventsBody(
      EN,
      [
        ev({
          id: 'tom',
          title: 'Only tomorrow',
          startMs: tomorrowStart + 9 * 60 * 60 * 1000,
          endMs: tomorrowStart + 10 * 60 * 60 * 1000,
        }),
      ],
      now,
      7,
    )
    expect(body).not.toContain(CALENDAR_EVENTS_DAY_DELIMITER)
    expect(localDayKey(tomorrowStart)).toBe('2024-03-11')
  })

  it('empty horizon names the day count', () => {
    expect(formatCalendarEventsBody(EN, [], now, 7)).toBe('No events in the next 7 day(s).')
  })

  it('speaks Italian when the hub language is it', () => {
    const body = formatCalendarEventsBody(
      IT,
      [
        ev({
          id: 'tom',
          title: 'Spazzatura',
          startMs: Date.UTC(2024, 2, 11),
          endMs: Date.UTC(2024, 2, 12),
          allDay: true,
        }),
      ],
      now,
      7,
    )
    expect(body).toContain('Domani')
    expect(body).toContain('Tutto il giorno')
    expect(body).not.toContain('Tomorrow')
    expect(body).not.toContain('All day')
  })
})
