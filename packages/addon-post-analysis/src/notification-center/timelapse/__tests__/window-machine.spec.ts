import { describe, it, expect } from 'vitest'
import type { NcSchedule } from '@camstack/types'
import {
  GENERATE_GUARD_MS,
  INITIAL_WINDOW_STATE,
  timelapseTick,
  type TimelapseWindowState,
} from '../window-machine.js'

/** A UTC weekday window; `dayOf` builds an instant inside/outside it. */
const schedule = (startMinute: number, endMinute: number, days: number[]): NcSchedule => ({
  windows: [{ days, startMinute, endMinute }],
  timezone: 'UTC',
})

/** An epoch for a given UTC weekday + minute-of-day. 2026-07-30 is a Thursday (day 4). */
function at(day: number, minute: number): number {
  const thursday = Date.UTC(2026, 6, 30) // day 4
  const dayDelta = day - 4
  return thursday + dayDelta * 86_400_000 + minute * 60_000
}

const state = (over: Partial<TimelapseWindowState> = {}): TimelapseWindowState => ({
  ...INITIAL_WINDOW_STATE,
  ...over,
})

describe('timelapseTick', () => {
  const window = schedule(9 * 60, 18 * 60, [4]) // Thu 09:00–18:00 UTC

  it('OPENS on entering the window, and resets the sample clock', () => {
    const out = timelapseTick({
      schedule: window,
      cadenceSec: 15,
      state: state({ lastSampleAt: 12345 }),
      nowMs: at(4, 9 * 60 + 1),
    })
    expect(out.action.kind).toBe('open')
    expect(out.next.open).toBe(true)
    // Reset so the FIRST frame lands immediately — a window whose beginning is
    // missing loses the part that shows the change starting.
    expect(out.next.lastSampleAt).toBe(0)
  })

  it('samples immediately after opening, then only once per cadence', () => {
    const t0 = at(4, 10 * 60)
    const first = timelapseTick({
      schedule: window,
      cadenceSec: 15,
      state: state({ open: true }),
      nowMs: t0,
    })
    expect(first.action.kind).toBe('sample')

    const tooSoon = timelapseTick({
      schedule: window,
      cadenceSec: 15,
      state: first.next,
      nowMs: t0 + 14_000,
    })
    expect(tooSoon.action.kind).toBe('idle')

    const due = timelapseTick({
      schedule: window,
      cadenceSec: 15,
      state: first.next,
      nowMs: t0 + 15_000,
    })
    expect(due.action.kind).toBe('sample')
  })

  it('CLOSES on leaving the window and stamps the generation', () => {
    const closeAt = at(4, 18 * 60 + 1)
    const out = timelapseTick({
      schedule: window,
      cadenceSec: 15,
      state: state({ open: true }),
      nowMs: closeAt,
    })
    expect(out.action.kind).toBe('close')
    expect(out.next.open).toBe(false)
    expect(out.next.lastGeneratedAt).toBe(closeAt)
  })

  // Without the guard a flapping window (an operator editing the schedule, a
  // clock correction) would re-render and re-notify over and over.
  it('SUPPRESSES a close inside the 1-hour guard, without re-stamping it', () => {
    const generatedAt = at(4, 18 * 60)
    const out = timelapseTick({
      schedule: window,
      cadenceSec: 15,
      state: state({ open: true, lastGeneratedAt: generatedAt }),
      nowMs: generatedAt + GENERATE_GUARD_MS - 1,
    })
    expect(out.action.kind).toBe('close-suppressed')
    expect(out.next.lastGeneratedAt).toBe(generatedAt)
  })

  it('allows the close once the guard has elapsed', () => {
    const generatedAt = at(4, 18 * 60)
    const out = timelapseTick({
      schedule: window,
      cadenceSec: 15,
      state: state({ open: true, lastGeneratedAt: generatedAt }),
      nowMs: generatedAt + GENERATE_GUARD_MS,
    })
    expect(out.action.kind).toBe('close')
  })

  it('is idle outside the window', () => {
    const out = timelapseTick({
      schedule: window,
      cadenceSec: 15,
      state: state(),
      nowMs: at(4, 8 * 60),
    })
    expect(out.action.kind).toBe('idle')
    expect(out.next.open).toBe(false)
  })

  it('handles a window that CROSSES MIDNIGHT (22:00 → 06:00)', () => {
    const nightly = schedule(22 * 60, 6 * 60, [4]) // opens Thu 22:00, closes Fri 06:00
    const opened = timelapseTick({
      schedule: nightly,
      cadenceSec: 60,
      state: state(),
      nowMs: at(4, 23 * 60),
    })
    expect(opened.action.kind).toBe('open')
    // Still inside at 02:00 on FRIDAY.
    const inside = timelapseTick({
      schedule: nightly,
      cadenceSec: 60,
      state: opened.next,
      nowMs: at(5, 2 * 60),
    })
    expect(inside.action.kind).toBe('sample')
    // Out at 07:00 Friday.
    const closed = timelapseTick({
      schedule: nightly,
      cadenceSec: 60,
      state: inside.next,
      nowMs: at(5, 7 * 60),
    })
    expect(closed.action.kind).toBe('close')
  })

  // A rule with no schedule is always inside (the convention rules already
  // use). It samples continuously and never hits a boundary — so it can only
  // ever be generated manually, which is the honest behaviour rather than
  // waiting forever for a close that cannot come.
  it('an UNSCHEDULED rule opens once and keeps sampling, never closing', () => {
    const opened = timelapseTick({
      schedule: undefined,
      cadenceSec: 10,
      state: state(),
      nowMs: at(4, 3 * 60),
    })
    expect(opened.action.kind).toBe('open')
    const next = timelapseTick({
      schedule: undefined,
      cadenceSec: 10,
      state: opened.next,
      nowMs: at(4, 3 * 60) + 10_000,
    })
    expect(next.action.kind).toBe('sample')
  })

  it('treats a zero/negative cadence as one second rather than a busy loop', () => {
    const t0 = at(4, 10 * 60)
    const first = timelapseTick({
      schedule: window,
      cadenceSec: 0,
      state: state({ open: true }),
      nowMs: t0,
    })
    const tooSoon = timelapseTick({
      schedule: window,
      cadenceSec: 0,
      state: first.next,
      nowMs: t0 + 999,
    })
    expect(tooSoon.action.kind).toBe('idle')
  })
})
