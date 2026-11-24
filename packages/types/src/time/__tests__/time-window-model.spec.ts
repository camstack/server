import { describe, expect, it } from 'vitest'
import { type TimeSite, zoneOnlySite } from '../time-spec.js'
import {
  DAY_WINDOW,
  NIGHT_WINDOW,
  type TimeWindow,
  TimeWindowSchema,
  isWithinTimeWindow,
  judgeTimeWindow,
} from '../time-window.js'

const ROME: TimeSite = { lat: 41.9028, lon: 12.4964, timeZone: 'Europe/Rome' }
const at = (iso: string): number => Date.parse(iso)
const clock = (hh: number, mm = 0) => ({ kind: 'clock' as const, hh, mm })
const sun = (event: 'sunrise' | 'sunset' | 'dawn' | 'dusk', offsetMin = 0) => ({
  kind: 'sun' as const,
  event,
  offsetMin,
})

const NIGHT_22_06: TimeWindow = { between: { from: clock(22), to: clock(6) } }
const NIGHT_WEEKDAYS: TimeWindow = {
  ...NIGHT_22_06,
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
}
const SUNSET_PLUS_2H: TimeWindow = {
  between: { from: sun('sunset', 120), to: clock(23, 59) },
}
const PRE_SUNRISE: TimeWindow = {
  between: { from: sun('sunrise', -60), to: clock(12) },
}

interface Row {
  readonly name: string
  readonly window: TimeWindow
  readonly now: string
  readonly inside: boolean
}

// January in Rome is UTC+1; sunrise ~07:35 local, sunset ~16:50 local.
const ROWS: readonly Row[] = [
  {
    name: 'wrap: 23:30 inside 22-06',
    window: NIGHT_22_06,
    now: '2026-01-14T22:30:00Z',
    inside: true,
  },
  {
    name: 'wrap: 05:59 inside 22-06',
    window: NIGHT_22_06,
    now: '2026-01-15T04:59:00Z',
    inside: true,
  },
  {
    name: 'wrap: 06:00 outside 22-06',
    window: NIGHT_22_06,
    now: '2026-01-15T05:00:00Z',
    inside: false,
  },
  {
    name: 'plain: noon inside 09-17',
    window: { between: { from: clock(9), to: clock(17) } },
    now: '2026-01-14T11:00:00Z',
    inside: true,
  },
  {
    name: 'sun offset: 1 h after sunset is not yet inside +2h',
    window: SUNSET_PLUS_2H,
    now: '2026-01-14T16:00:00Z',
    inside: false,
  },
  {
    name: 'sun offset: 3 h after sunset is inside +2h',
    window: SUNSET_PLUS_2H,
    now: '2026-01-14T18:30:00Z',
    inside: true,
  },
  {
    name: 'sun offset: 1 h before sunrise inside',
    window: PRE_SUNRISE,
    now: '2026-01-15T06:00:00Z',
    inside: true,
  },
  {
    name: 'weekday: Tue 23:00 inside',
    window: NIGHT_WEEKDAYS,
    now: '2026-01-13T22:00:00Z',
    inside: true,
  },
  {
    name: 'weekday: Sat 01:00 started Friday',
    window: NIGHT_WEEKDAYS,
    now: '2026-01-17T00:00:00Z',
    inside: true,
  },
  {
    name: 'weekday: Sun 01:00 started Saturday',
    window: NIGHT_WEEKDAYS,
    now: '2026-01-18T00:00:00Z',
    inside: false,
  },
  {
    name: 'days only: Saturday midday',
    window: { days: ['sat', 'sun'] },
    now: '2026-01-17T11:00:00Z',
    inside: true,
  },
  {
    name: 'days only: Friday midday',
    window: { days: ['sat', 'sun'] },
    now: '2026-01-16T11:00:00Z',
    inside: false,
  },
  {
    name: 'preset night: 03:00 inside',
    window: NIGHT_WINDOW,
    now: '2026-01-15T02:00:00Z',
    inside: true,
  },
  {
    name: 'preset night: noon outside',
    window: NIGHT_WINDOW,
    now: '2026-01-15T11:00:00Z',
    inside: false,
  },
  {
    name: 'preset day: noon inside',
    window: DAY_WINDOW,
    now: '2026-01-15T11:00:00Z',
    inside: true,
  },
  {
    name: 'preset day: 03:00 outside',
    window: DAY_WINDOW,
    now: '2026-01-15T02:00:00Z',
    inside: false,
  },
  {
    name: 'preset night on weekdays: Sat 03:00 started Friday',
    window: { ...NIGHT_WINDOW, days: ['fri'] },
    now: '2026-01-17T02:00:00Z',
    inside: true,
  },
  {
    name: 'preset night on weekdays: Sun 03:00 started Saturday',
    window: { ...NIGHT_WINDOW, days: ['fri'] },
    now: '2026-01-18T02:00:00Z',
    inside: false,
  },
]

describe('isWithinTimeWindow', () => {
  it.each(ROWS)('$name', ({ window, now, inside }) => {
    expect(isWithinTimeWindow(window, at(now), ROME)).toBe(inside)
    expect(judgeTimeWindow(window, at(now), ROME).inside).toBe(inside)
  })

  it('is false, never a guess, for a sun window on a zone-only site', () => {
    const site = zoneOnlySite('Europe/Rome')
    expect(isWithinTimeWindow(NIGHT_WINDOW, at('2026-01-15T02:00:00Z'), site)).toBe(false)
    expect(judgeTimeWindow(NIGHT_WINDOW, at('2026-01-15T02:00:00Z'), site).unknown).toBe(true)
  })
})

describe('TimeWindowSchema', () => {
  it.each([
    ['an empty window', {}],
    [
      'a one-date bound',
      {
        between: {
          from: { kind: 'date', local: '2026-12-24T18:00' },
          to: clock(6),
        },
      },
    ],
    ['a preset with a between', { preset: 'night', between: { from: clock(1), to: clock(2) } }],
    ['an unknown preset', { preset: 'dusk' }],
    ['an empty days list', { days: [] }],
  ])('refuses %s', (_name, value) => {
    expect(TimeWindowSchema.safeParse(value).success).toBe(false)
  })

  it.each([
    ['a preset alone', { preset: 'night' }],
    ['a preset with days', { preset: 'day', days: ['mon'] }],
    ['a sun range', { between: { from: sun('sunset', -30), to: sun('sunrise', 15) } }],
    ['days alone', { days: ['sat'] }],
  ])('accepts %s', (_name, value) => {
    expect(TimeWindowSchema.safeParse(value).success).toBe(true)
  })
})
