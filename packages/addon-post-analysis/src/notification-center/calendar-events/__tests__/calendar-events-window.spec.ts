import { describe, expect, it } from 'vitest'
import {
  CALENDAR_EVENTS_DAY_MS,
  CALENDAR_EVENTS_DEFAULT_HORIZON_DAYS,
  CALENDAR_EVENTS_MAX_HORIZON_DAYS,
  CALENDAR_EVENTS_MIN_HORIZON_DAYS,
  calendarEventsWindow,
} from '../calendar-events-window.js'

describe('calendarEventsWindow', () => {
  const NOW = 1_700_000_000_000

  it('spans now → now + horizonDays', () => {
    const w = calendarEventsWindow(NOW, 3)
    expect(w.startMs).toBe(NOW)
    expect(w.endMs).toBe(NOW + 3 * CALENDAR_EVENTS_DAY_MS)
    expect(w.horizonDays).toBe(3)
  })

  it('clamps below the minimum to one day', () => {
    const w = calendarEventsWindow(NOW, 0)
    expect(w.horizonDays).toBe(CALENDAR_EVENTS_MIN_HORIZON_DAYS)
    expect(w.endMs - w.startMs).toBe(CALENDAR_EVENTS_DAY_MS)
  })

  it('clamps above the maximum to thirty days', () => {
    const w = calendarEventsWindow(NOW, 99)
    expect(w.horizonDays).toBe(CALENDAR_EVENTS_MAX_HORIZON_DAYS)
    expect(w.endMs - w.startMs).toBe(CALENDAR_EVENTS_MAX_HORIZON_DAYS * CALENDAR_EVENTS_DAY_MS)
  })

  it('default horizon is seven days', () => {
    expect(CALENDAR_EVENTS_DEFAULT_HORIZON_DAYS).toBe(7)
    const w = calendarEventsWindow(NOW, CALENDAR_EVENTS_DEFAULT_HORIZON_DAYS)
    expect(w.endMs - w.startMs).toBe(7 * CALENDAR_EVENTS_DAY_MS)
  })
})
