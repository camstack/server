/**
 * D652 — an occupancy burst completes on INFERENCE, not on enqueue.
 *
 * The dial path used to enqueue its 4th frame and call `cleanup()` in the same
 * synchronous turn: the worker was killed under the frames it had just
 * admitted, and the burst's verdict (`found`) was read before any of them had
 * been inferred. Live: 122 of 187 bursts lost at least one frame, and the
 * verdict was computed from fewer frames than the burst collected, with no
 * log line. The ledger is what "complete" now means: every admitted frame has
 * SETTLED — inferred, or let go by the runner — or a bound has expired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OccupancyBurstLedger, type OccupancyBurstSummary } from '../occupancy-burst-ledger.js'

describe('OccupancyBurstLedger', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function ledger(settleBoundMs = 5_000) {
    const done: OccupancyBurstSummary[] = []
    const l = new OccupancyBurstLedger({ settleBoundMs, onComplete: (s) => done.push(s) })
    return { l, done }
  }

  it('does not complete when admission closes — only when the last admitted frame settles', () => {
    const { l, done } = ledger()
    const a = l.admit()
    const b = l.admit()
    const c = l.admit()
    const d = l.admit()
    l.close()
    expect(done).toEqual([])
    a('inferred')
    b('lost')
    c('inferred')
    expect(done).toEqual([])
    d('inferred')
    expect(done).toEqual([
      { frames: 4, inferred: 3, superseded: 0, lost: 1, unsettled: 0, timedOut: false },
    ])
  })

  it('settling before close does not complete a burst that may still collect', () => {
    const { l, done } = ledger()
    l.admit()('inferred')
    expect(done).toEqual([])
    l.close()
    expect(done).toEqual([
      { frames: 1, inferred: 1, superseded: 0, lost: 0, unsettled: 0, timedOut: false },
    ])
  })

  it('a stuck frame cannot pin the burst: the bound completes it and counts the frame lost', () => {
    const { l, done } = ledger(5_000)
    l.admit()('inferred')
    l.admit() // never settles — e.g. an inference that hangs
    l.close()
    vi.advanceTimersByTime(4_999)
    expect(done).toEqual([])
    vi.advanceTimersByTime(1)
    expect(done).toEqual([
      { frames: 2, inferred: 1, superseded: 0, lost: 1, unsettled: 1, timedOut: true },
    ])
  })

  it('completes exactly once, and a settle after completion changes nothing', () => {
    const { l, done } = ledger(10)
    const late = l.admit()
    l.close()
    vi.advanceTimersByTime(10)
    late('inferred')
    late('inferred')
    vi.advanceTimersByTime(100)
    expect(done).toHaveLength(1)
    expect(done[0]?.inferred).toBe(0)
  })

  it('a settle callback is idempotent — one frame is one outcome', () => {
    const { l, done } = ledger()
    const a = l.admit()
    a('inferred')
    a('lost')
    l.close()
    expect(done).toEqual([
      { frames: 1, inferred: 1, superseded: 0, lost: 0, unsettled: 0, timedOut: false },
    ])
  })

  it('a burst that collected nothing completes at close', () => {
    const { l, done } = ledger()
    l.close()
    expect(done).toEqual([
      { frames: 0, inferred: 0, superseded: 0, lost: 0, unsettled: 0, timedOut: false },
    ])
  })

  // M3: `lost` means REAL loss. A frame a newer frame of the same burst
  // replaced on the latest-only queue is the queue's design: the verdict saw a
  // later look at the same scene.
  it('a superseded frame is counted apart and is not lost', () => {
    const { l, done } = ledger()
    const a = l.admit()
    const b = l.admit()
    const c = l.admit()
    l.close()
    a('superseded')
    b('superseded')
    c('inferred')
    expect(done).toEqual([
      { frames: 3, inferred: 1, superseded: 2, lost: 0, unsettled: 0, timedOut: false },
    ])
  })
})
