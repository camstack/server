import { describe, expect, it, vi } from 'vitest'
import { nextTimeBoundaryInMs } from '../../automation/condition-eval.js'
import { isWithinClockRange } from '../clock-range.js'
import { zoneOnlySite } from '../time-spec.js'
import * as flip from '../time-window-flip.js'
import { type TimeWindow, isWithinTimeWindow, judgeTimeWindow } from '../time-window.js'

vi.mock('../time-window-flip.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../time-window-flip.js')>()
  return { ...real, nextVerdictFlip: vi.fn(real.nextVerdictFlip) }
})

const BERLIN = zoneOnlySite('Europe/Berlin')
const LORD_HOWE = zoneOnlySite('Australia/Lord_Howe')
const UTC = zoneOnlySite('UTC')
const clock = (hh: number, mm = 0) => ({ kind: 'clock' as const, hh, mm })
const MIN = 60_000
const window2204: TimeWindow = { between: { from: clock(22), to: clock(4) } }

describe('the inside-only path never runs the flip search', () => {
  it('isWithinTimeWindow and isWithinClockRange leave the search uncalled, judgeTimeWindow calls it', () => {
    const spy = vi.mocked(flip.nextVerdictFlip)
    spy.mockClear()
    const t0 = Date.UTC(2026, 9, 25, 0, 0)
    isWithinTimeWindow(window2204, t0, BERLIN)
    isWithinClockRange(undefined, 22 * 60, 4 * 60, t0, BERLIN)
    expect(spy).not.toHaveBeenCalled()
    judgeTimeWindow(window2204, t0, BERLIN)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('a minute-by-minute scan of 2 days stays cheap', () => {
    const t0 = Date.UTC(2026, 9, 25, 0, 0)
    const started = performance.now()
    for (let i = 0; i < 2880; i += 1)
      isWithinClockRange(undefined, 22 * 60, 4 * 60, t0 + i * MIN, BERLIN)
    expect(performance.now() - started).toBeLessThan(50)
  })
})

describe('nextChangeAtMs outside Berlin DST', () => {
  const next = (w: TimeWindow, at: number, site = UTC): number | null =>
    judgeTimeWindow(w, at, site).nextChangeAtMs

  it('UTC has no jump: the plain boundary', () => {
    expect(next(window2204, Date.UTC(2026, 5, 1, 12, 0))).toBe(Date.UTC(2026, 5, 1, 22, 0))
    expect(next(window2204, Date.UTC(2026, 5, 1, 23, 0))).toBe(Date.UTC(2026, 5, 2, 4, 0))
  })

  it('from == to is the whole day: inside, and the verdict never flips', () => {
    const w: TimeWindow = { between: { from: clock(6), to: clock(6) } }
    const j = judgeTimeWindow(w, Date.UTC(2026, 5, 1, 12, 0), UTC)
    expect(j.inside).toBe(true)
    expect(j.nextChangeAtMs).toBeNull()
  })

  it('days-restricted: the next listed day is found up to a week ahead', () => {
    // Monday-only 22:00-23:00; asked on a Tuesday the next flip is the following Monday.
    const w: TimeWindow = {
      between: { from: clock(22), to: clock(23) },
      days: ['mon'],
    }
    expect(next(w, Date.UTC(2026, 5, 2, 12, 0))).toBe(Date.UTC(2026, 5, 8, 22, 0)) // Tue -> Mon 2026-06-08
    expect(next(w, Date.UTC(2026, 5, 1, 12, 0))).toBe(Date.UTC(2026, 5, 1, 22, 0)) // the Monday itself
  })

  it('days-restricted across the spring-forward day: Berlin Monday 22:00 CEST is 20:00Z', () => {
    const w: TimeWindow = {
      between: { from: clock(22), to: clock(23) },
      days: ['mon'],
    }
    expect(next(w, Date.UTC(2026, 2, 24, 12, 0), BERLIN)).toBe(Date.UTC(2026, 2, 30, 20, 0)) // Tue 24 Mar
    expect(next(w, Date.UTC(2026, 2, 29, 12, 0), BERLIN)).toBe(Date.UTC(2026, 2, 30, 20, 0)) // the DST Sunday
  })

  it('nextTimeBoundaryInMs, the scheduler wake source, arms a Monday-only leaf asked on a Tuesday', () => {
    const leaf = {
      kind: 'time-is' as const,
      days: ['mon' as const],
      between: { from: clock(22), to: clock(23) },
    }
    const now = Date.UTC(2026, 5, 2, 12, 0) // Tuesday
    expect(nextTimeBoundaryInMs(leaf, now, UTC)).toBe(Date.UTC(2026, 5, 8, 22, 0) - now)
  })

  it('an all-day-from-each-Monday window ends the next morning', () => {
    const w: TimeWindow = {
      between: { from: clock(6), to: clock(6) },
      days: ['mon'],
    }
    // Whole 24 h from each Monday 06:00: asked mid-Monday, it ends Tuesday 06:00.
    expect(next(w, Date.UTC(2026, 5, 1, 12, 0))).toBe(Date.UTC(2026, 5, 2, 6, 0))
  })

  it('Lord Howe repeats half an hour on 2026-04-05: the second 01:45 is 30 min after the first would be, not 60', () => {
    // 02:00 LHDT (+11) becomes 01:30 LHST (+10:30) at 2026-04-04 15:00Z; 01:30-01:59 happens twice.
    const w: TimeWindow = { between: { from: clock(1, 45), to: clock(1, 50) } }
    const at = Date.UTC(2026, 3, 4, 14, 55) // 01:55 LHDT, first pass, outside
    expect(next(w, at, LORD_HOWE)).toBe(Date.UTC(2026, 3, 4, 15, 15)) // 01:45 LHST
    expect(next(w, Date.UTC(2026, 3, 4, 15, 16), LORD_HOWE)).toBe(Date.UTC(2026, 3, 4, 15, 20))
  })
})
