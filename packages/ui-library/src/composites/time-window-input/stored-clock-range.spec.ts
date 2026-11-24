import { describe, expect, it } from 'vitest'
import type { NcScheduleWindow, TimeWindow } from '@camstack/types'
import {
  bandOfTimeWindow,
  ncWindowOfTimeWindow,
  timeWindowOfBand,
  timeWindowOfNcWindow,
  type StoredBandRange,
} from './stored-clock-range.js'

const NC_CASES: readonly { name: string; w: NcScheduleWindow }[] = [
  { name: 'office hours', w: { days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1080 } },
  { name: 'overnight, crosses midnight', w: { days: [5, 6], startMinute: 1320, endMinute: 360 } },
  {
    name: 'every day listed (Sunday first)',
    w: { days: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 1439 },
  },
  {
    name: 'a list in the order it was stored',
    w: { days: [6, 0, 3], startMinute: 61, endMinute: 62 },
  },
  {
    name: 'equal ends (empty for the schedule)',
    w: { days: [2], startMinute: 600, endMinute: 600 },
  },
  { name: 'midnight start', w: { days: [1], startMinute: 0, endMinute: 1 } },
]

const BAND_CASES: readonly { name: string; b: StoredBandRange }[] = [
  { name: 'weekday daytime', b: { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:30' } },
  { name: 'overnight', b: { days: [0, 6], start: '22:00', end: '06:00' } },
  { name: 'no days means every day', b: { days: [], start: '00:00', end: '12:00' } },
  {
    name: 'all seven days listed stays a list',
    b: { days: [1, 2, 3, 4, 5, 6, 0], start: '00:00', end: '23:59' },
  },
  { name: 'whole day (equal ends)', b: { days: [], start: '00:00', end: '00:00' } },
  { name: 'equal ends away from midnight', b: { days: [3], start: '09:05', end: '09:05' } },
  { name: 'unordered list', b: { days: [6, 2], start: '01:02', end: '03:04' } },
]

const CLOCK_1_TO_2: TimeWindow = {
  between: { from: { kind: 'clock', hh: 1, mm: 0 }, to: { kind: 'clock', hh: 2, mm: 0 } },
}

describe('notification schedule window <-> TimeWindow', () => {
  for (const { name, w } of NC_CASES) {
    it(`round-trips: ${name}`, () => {
      expect(ncWindowOfTimeWindow(timeWindowOfNcWindow(w))).toEqual(w)
    })
  }

  it('reads Sunday as 0 and a clock window as two clock ends', () => {
    expect(timeWindowOfNcWindow({ days: [0, 1], startMinute: 1320, endMinute: 360 })).toEqual({
      days: ['sun', 'mon'],
      between: { from: { kind: 'clock', hh: 22, mm: 0 }, to: { kind: 'clock', hh: 6, mm: 0 } },
    })
  })

  it('an absent day list (every day) is stored as all seven days', () => {
    expect(ncWindowOfTimeWindow(CLOCK_1_TO_2)).toEqual({
      days: [1, 2, 3, 4, 5, 6, 0],
      startMinute: 60,
      endMinute: 120,
    })
  })

  it('refuses what a schedule cannot store, instead of dropping it', () => {
    expect(ncWindowOfTimeWindow({ days: ['mon'] })).toBeNull()
    expect(ncWindowOfTimeWindow({ preset: 'night' })).toBeNull()
    expect(
      ncWindowOfTimeWindow({
        between: {
          from: { kind: 'sun', event: 'sunset', offsetMin: 0 },
          to: { kind: 'clock', hh: 1, mm: 0 },
        },
      }),
    ).toBeNull()
    expect(ncWindowOfTimeWindow({ ...CLOCK_1_TO_2, days: [] })).toBeNull()
  })
})

describe('recording band range <-> TimeWindow', () => {
  for (const { name, b } of BAND_CASES) {
    it(`round-trips: ${name}`, () => {
      expect(bandOfTimeWindow(timeWindowOfBand(b))).toEqual(b)
    })
  }

  it('empty days is the absence of the day list', () => {
    expect(timeWindowOfBand({ days: [], start: '01:00', end: '02:00' }).days).toBeUndefined()
  })

  it('an absent day list is stored as the empty list (every day)', () => {
    expect(
      bandOfTimeWindow({
        between: { from: { kind: 'clock', hh: 7, mm: 5 }, to: { kind: 'clock', hh: 8, mm: 0 } },
      }),
    ).toEqual({ days: [], start: '07:05', end: '08:00' })
  })

  it('refuses a window with no range, a sun end or an empty draft day list', () => {
    expect(bandOfTimeWindow({ days: ['mon'] })).toBeNull()
    expect(bandOfTimeWindow({ preset: 'day' })).toBeNull()
    expect(bandOfTimeWindow({ ...CLOCK_1_TO_2, days: [] })).toBeNull()
  })
})
