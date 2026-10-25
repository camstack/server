import { isScheduleActive, scheduleForSendTimes } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { decideStateSummary, NC_STATE_SUMMARY_GRACE_MS } from '../state-summary-window.js'

const MIN = 60_000
const HOUR = 60 * MIN

/** "Send at 08:00 every day, UTC." */
const DAILY_8_UTC = scheduleForSendTimes([{ days: [0, 1, 2, 3, 4, 5, 6], minute: 8 * 60 }], 'UTC')

describe('decideStateSummary — the send time is the END of a schedule window', () => {
  const at0800 = Date.UTC(2026, 8, 25, 8, 0)
  const longAgo = Date.UTC(2026, 8, 20)

  it('nothing before the window closes', () => {
    expect(
      decideStateSummary({
        schedule: DAILY_8_UTC,
        nowMs: at0800 - MIN,
        floorMs: at0800 - 10 * HOUR,
      }),
    ).toEqual({ kind: 'idle' })
  })

  it('fires on the first tick at or after the close, and names that window', () => {
    const decision = decideStateSummary({
      schedule: DAILY_8_UTC,
      nowMs: at0800 + 30_000,
      floorMs: at0800 - 10 * HOUR,
    })
    expect(decision).toEqual({
      kind: 'send',
      window: { startMs: at0800 - MIN, endMs: at0800 },
      late: false,
    })
  })

  it('a window already sent (the floor) is never sent again — a restart does not double-send', () => {
    expect(
      decideStateSummary({ schedule: DAILY_8_UTC, nowMs: at0800 + 5 * MIN, floorMs: at0800 }),
    ).toEqual({ kind: 'idle' })
    // …and the next day's window is the next send.
    const next = decideStateSummary({
      schedule: DAILY_8_UTC,
      nowMs: at0800 + 24 * HOUR,
      floorMs: at0800,
    })
    expect(next).toMatchObject({ kind: 'send', window: { endMs: at0800 + 24 * HOUR } })
  })

  it('a restart after the close, inside the grace, sends it LATE — never skips it silently', () => {
    const decision = decideStateSummary({
      schedule: DAILY_8_UTC,
      nowMs: at0800 + 2 * HOUR,
      floorMs: longAgo,
    })
    expect(decision).toMatchObject({ kind: 'send', late: true, window: { endMs: at0800 } })
  })

  it('past the grace it is MISSED — reported, not sent hours after its time', () => {
    const decision = decideStateSummary({
      schedule: DAILY_8_UTC,
      nowMs: at0800 + NC_STATE_SUMMARY_GRACE_MS + MIN,
      floorMs: longAgo,
    })
    expect(decision).toMatchObject({ kind: 'missed', window: { endMs: at0800 } })
  })

  it('a window that closed before the rule was armed is not owed', () => {
    expect(
      decideStateSummary({
        schedule: DAILY_8_UTC,
        nowMs: at0800 + HOUR,
        floorMs: at0800 + 30 * MIN,
      }),
    ).toEqual({ kind: 'idle' })
  })

  it('honours the schedule TIMEZONE: 08:00 in Rome is 06:00 UTC in summer', () => {
    const rome = scheduleForSendTimes(
      [{ days: [0, 1, 2, 3, 4, 5, 6], minute: 8 * 60 }],
      'Europe/Rome',
    )
    const romeEight = Date.UTC(2026, 8, 25, 6, 0)
    expect(
      decideStateSummary({ schedule: rome, nowMs: romeEight - MIN, floorMs: longAgo }),
    ).toMatchObject({
      // The previous day's close, long past the grace.
      kind: 'missed',
    })
    expect(
      decideStateSummary({ schedule: rome, nowMs: romeEight + MIN, floorMs: romeEight - HOUR }),
    ).toMatchObject({ kind: 'send', window: { endMs: romeEight } })
  })

  it('MIDNIGHT: "Monday 00:00" closes at the start of Monday, from a window that opened Sunday', () => {
    const monday = scheduleForSendTimes([{ days: [1], minute: 0 }], 'UTC')
    const mondayMidnight = Date.UTC(2026, 8, 28, 0, 0) // 2026-09-28 is a Monday
    expect(
      decideStateSummary({ schedule: monday, nowMs: mondayMidnight + MIN, floorMs: longAgo }),
    ).toMatchObject({
      kind: 'send',
      window: { startMs: mondayMidnight - MIN, endMs: mondayMidnight },
      late: false,
    })
    // Sunday 23:59 is still before it.
    expect(
      decideStateSummary({
        schedule: monday,
        nowMs: mondayMidnight - MIN,
        floorMs: mondayMidnight - HOUR,
      }),
    ).toEqual({ kind: 'idle' })
  })
})

describe('the decision is O(windows × days), not O(minutes) (D647 review I4)', () => {
  it('a weekly rule whose floor is a week back asks isScheduleActive a few dozen times, not ten thousand', () => {
    const weekly = scheduleForSendTimes([{ days: [1], minute: 8 * 60 }], 'Europe/Rome')
    const mondayRome = Date.UTC(2026, 8, 28, 6, 0)
    let calls = 0
    const probe = (schedule: Parameters<typeof isScheduleActive>[0], atMs: number): boolean => {
      calls += 1
      return isScheduleActive(schedule, atMs)
    }
    const started = performance.now()
    const decision = decideStateSummary({
      schedule: weekly,
      nowMs: mondayRome + MIN,
      floorMs: mondayRome - 7 * 24 * HOUR + MIN,
      probe,
    })
    const elapsed = performance.now() - started
    expect(decision).toMatchObject({ kind: 'send', window: { endMs: mondayRome } })
    // A minute scan over the same week was ≈ 10 080 probes.
    expect(calls).toBeLessThan(200)
    expect(elapsed).toBeLessThan(500)
  })
})

describe('a rule armed INSIDE a window is sent at its close (review M1)', () => {
  it('a long window that opened before the arm still closes after it', () => {
    const morning = {
      windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 7 * 60, endMinute: 8 * 60 }],
      timezone: 'UTC',
    }
    const at0800 = Date.UTC(2026, 8, 25, 8, 0)
    expect(
      decideStateSummary({ schedule: morning, nowMs: at0800 + MIN, floorMs: at0800 - 30 * MIN }),
    ).toMatchObject({ kind: 'send', window: { startMs: at0800 - HOUR, endMs: at0800 } })
  })
})
