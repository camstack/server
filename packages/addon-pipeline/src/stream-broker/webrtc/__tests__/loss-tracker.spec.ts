// __tests__/loss-tracker.spec.ts
import { describe, it, expect } from 'vitest'
import { LossTracker } from '../loss-tracker.js'

const cfg = { analyzeWindowMs: 15_000, minFailPercent: 0.05, waitAfterResetMs: 8_000 }

describe('LossTracker', () => {
  it('not failing with no samples', () => {
    const t = new LossTracker(cfg)
    expect(t.isFailing(1000)).toBe(false)
  })

  it('computes loss ratio across the window and flags failing above threshold', () => {
    const t = new LossTracker(cfg)
    t.track({ packetsLost: 0, highestSequence: 1000 }, 0)
    t.track({ packetsLost: 60, highestSequence: 2000 }, 1000) // 60 lost / 1000 seq = 6%
    expect(t.isFailing(1000)).toBe(true)
  })

  it('stays healthy below threshold', () => {
    const t = new LossTracker(cfg)
    t.track({ packetsLost: 0, highestSequence: 1000 }, 0)
    t.track({ packetsLost: 30, highestSequence: 2000 }, 1000) // 3%
    expect(t.isFailing(1000)).toBe(false)
  })

  it('drops samples older than the window', () => {
    const t = new LossTracker(cfg)
    t.track({ packetsLost: 0, highestSequence: 1000 }, 0)
    t.track({ packetsLost: 600, highestSequence: 2000 }, 20_000) // first sample expired
    expect(t.isFailing(20_000)).toBe(false) // only one in-window sample → no delta
  })

  it('ignores samples during the reset-wait after markChanged', () => {
    const t = new LossTracker(cfg)
    t.markChanged(0)
    t.track({ packetsLost: 0, highestSequence: 1000 }, 1000)
    t.track({ packetsLost: 600, highestSequence: 2000 }, 2000) // within waitAfterResetMs
    expect(t.isFailing(2000)).toBe(false)
  })

  it('resumes tracking after the reset-wait elapses', () => {
    const t = new LossTracker(cfg)
    t.markChanged(0)
    t.track({ packetsLost: 0, highestSequence: 1000 }, 9_000)
    t.track({ packetsLost: 100, highestSequence: 2000 }, 10_000) // 10%
    expect(t.isFailing(10_000)).toBe(true)
  })
})
