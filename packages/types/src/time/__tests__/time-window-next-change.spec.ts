import { describe, expect, it } from 'vitest'
import { zoneOnlySite } from '../time-spec.js'
import { type TimeWindow, judgeTimeWindow } from '../time-window.js'

// Berlin 2026: falls back Sun 25 Oct (01:00Z; 02:00-02:59 wall clock happens twice)
// and springs forward Sun 29 Mar (01:00Z; 02:00-02:59 does not exist).
const BERLIN = zoneOnlySite('Europe/Berlin')
const clock = (hh: number, mm = 0) => ({ kind: 'clock' as const, hh, mm })
const MIN = 60_000
const fall = (h: number, m: number): number => Date.UTC(2026, 9, 25, h, m)
const spring = (h: number, m: number): number => Date.UTC(2026, 2, 29, h, m)

/** The first minute after `from` at which the verdict differs, found by brute force. */
function firstFlip(w: TimeWindow, from: number): number | null {
  const start = judgeTimeWindow(w, from, BERLIN).inside
  for (let t = from + MIN; t < from + 72 * 60 * MIN; t += MIN) {
    if (judgeTimeWindow(w, t, BERLIN).inside !== start) return t
  }
  return null
}

function expectNextIsTheFlip(w: TimeWindow, from: number): void {
  const flip = firstFlip(w, from)
  expect(judgeTimeWindow(w, from, BERLIN).nextChangeAtMs).toBe(flip)
}

describe('nextChangeAtMs of a clock window is the first real verdict flip on a DST day', () => {
  const partial: TimeWindow = { between: { from: clock(2, 15), to: clock(2, 40) } }

  it('fall-back: after the first pass, the next start is the SECOND 02:15', () => {
    expect(judgeTimeWindow(partial, fall(0, 50), BERLIN).nextChangeAtMs).toBe(fall(1, 15))
    expectNextIsTheFlip(partial, fall(0, 50))
  })

  it('fall-back: inside the second pass, the end is the SECOND 02:40', () => {
    expect(judgeTimeWindow(partial, fall(1, 20), BERLIN).nextChangeAtMs).toBe(fall(1, 40))
    expectNextIsTheFlip(partial, fall(1, 20))
  })

  it('fall-back: a window ending at 02:30 re-opens when the clock repeats 02:00', () => {
    const w: TimeWindow = { between: { from: clock(0), to: clock(2, 30) } }
    expect(judgeTimeWindow(w, fall(0, 35), BERLIN).nextChangeAtMs).toBe(fall(1, 0))
    expectNextIsTheFlip(w, fall(0, 35))
    expectNextIsTheFlip(w, fall(1, 10))
  })

  it('spring-forward: a window starting inside the skipped hour opens when the clock jumps', () => {
    const w: TimeWindow = { between: { from: clock(2, 30), to: clock(5) } }
    expect(judgeTimeWindow(w, spring(0, 0), BERLIN).nextChangeAtMs).toBe(spring(1, 0))
    expectNextIsTheFlip(w, spring(0, 0))
  })

  it('spring-forward: a window ending inside the skipped hour closes when the clock jumps', () => {
    const w: TimeWindow = { between: { from: clock(1), to: clock(2, 30) } }
    expect(judgeTimeWindow(w, spring(0, 10), BERLIN).nextChangeAtMs).toBe(spring(1, 0))
    expectNextIsTheFlip(w, spring(0, 10))
  })

  it('spring-forward: an ordinary boundary after the jump is one real hour earlier in UTC', () => {
    const w: TimeWindow = { between: { from: clock(22), to: clock(4) } }
    expectNextIsTheFlip(w, spring(0, 30))
    expectNextIsTheFlip(w, spring(2, 0))
  })
})
