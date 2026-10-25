/**
 * Stall-sampler accounting. The one judgement (GC vs synchronous block) is
 * delegated to the boot monitor's `attributeStall`, so these tests pin the
 * SAMPLER's own seams: threshold gating, cumulative folding, snapshot
 * diffing, and the tick wiring under an injected ticker + clock.
 */
import { describe, expect, it } from 'vitest'
import {
  applyStallTick,
  diffStallSamples,
  type StallSample,
  startStallSampler,
} from '../stall-sampler.js'

const ZERO: StallSample = { count: 0, maxMs: 0, totalMs: 0, gcMs: 0, syncCount: 0, gcCount: 0 }
const NO_GC = { totalMs: 0, count: 0, longestMs: 0 }

describe('applyStallTick', () => {
  it('lateness under the threshold is scheduling jitter, not a stall', () => {
    expect(applyStallTick(ZERO, 1999, NO_GC, 2000)).toBe(ZERO)
    expect(applyStallTick(ZERO, 80, NO_GC, 2000)).toBe(ZERO)
  })

  it('a stall with ~zero GC is classified synchronous-block', () => {
    const s = applyStallTick(ZERO, 9455, { totalMs: 4, count: 1, longestMs: 4 }, 2000)
    expect(s.count).toBe(1)
    expect(s.syncCount).toBe(1)
    expect(s.gcCount).toBe(0)
    expect(s.maxMs).toBe(9455)
    expect(s.totalMs).toBe(9455)
  })

  it('a stall dominated by GC pauses is classified gc', () => {
    const s = applyStallTick(ZERO, 3000, { totalMs: 2800, count: 3, longestMs: 1500 }, 2000)
    expect(s.count).toBe(1)
    expect(s.gcCount).toBe(1)
    expect(s.syncCount).toBe(0)
    expect(s.gcMs).toBe(2800)
  })

  it('folds cumulatively and keeps the max', () => {
    let s = applyStallTick(ZERO, 2500, NO_GC, 2000)
    s = applyStallTick(s, 8000, NO_GC, 2000)
    s = applyStallTick(s, 3000, NO_GC, 2000)
    expect(s.count).toBe(3)
    expect(s.maxMs).toBe(8000)
    expect(s.totalMs).toBe(13500)
    expect(s.syncCount).toBe(3)
  })
})

describe('diffStallSamples', () => {
  it('subtracts counters; max stays the run max (conservative)', () => {
    const start: StallSample = {
      count: 2,
      maxMs: 5000,
      totalMs: 7000,
      gcMs: 100,
      syncCount: 1,
      gcCount: 1,
    }
    const end: StallSample = {
      count: 5,
      maxMs: 9000,
      totalMs: 20000,
      gcMs: 400,
      syncCount: 3,
      gcCount: 2,
    }
    expect(diffStallSamples(start, end)).toEqual({
      count: 3,
      maxMs: 9000,
      totalMs: 13000,
      gcMs: 300,
      syncCount: 2,
      gcCount: 1,
    })
  })
})

describe('startStallSampler (injected ticker + clock)', () => {
  it('counts a late tick against the threshold and resets the schedule after it', () => {
    let t = 0
    let tick: (() => void) | null = null
    const sampler = startStallSampler({
      tickMs: 250,
      reportThresholdMs: 2000,
      now: () => t,
      observeGc: false,
      createTicker: (onTick) => {
        tick = onTick
        return () => {
          tick = null
        }
      },
    })

    const fireTick = (): void => {
      if (tick !== null) tick()
    }

    // On-time tick: expected at 250, arrives at 250 → no stall.
    t = 250
    fireTick()
    expect(sampler.snapshot().count).toBe(0)

    // The loop freezes: the next tick (expected 500) arrives at 9705.
    t = 9705
    fireTick()
    expect(sampler.snapshot()).toMatchObject({ count: 1, maxMs: 9205, syncCount: 1 })

    // Schedule re-anchors after the stall: the next on-time tick is clean.
    t = 9955
    fireTick()
    expect(sampler.snapshot().count).toBe(1)

    sampler.stop()
    expect(tick).toBeNull()
  })
})
