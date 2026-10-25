import { describe, expect, it } from 'vitest'
import { FrameGovernor } from '../frame-governor.js'

const cfg = { targetLoadPercent: 80, minThrottledFps: 2, maxConcurrentInferences: 2 }

describe('FrameGovernor', () => {
  it('imposes no throttle when load fits the budget', () => {
    const g = new FrameGovernor(cfg)
    // budget = 0.8 * 2 * 1000 = 1600 ms/s; one camera at 30ms/frame, 25fps → 750ms/s
    g.update(new Map([[104, { avgInferenceMs: 30, configuredFps: 0, decodeFps: 25 }]]))
    expect(g.minIntervalMs(104)).toBe(1000 / 25) // capped only by decode rate
    expect(g.throttledCount()).toBe(0)
  })

  it('throttles a camera whose per-frame cost exceeds its share', () => {
    const g = new FrameGovernor(cfg)
    // one camera at 726ms/frame → target fps = 1600/726 ≈ 2.2
    g.update(new Map([[104, { avgInferenceMs: 726, configuredFps: 0, decodeFps: 25 }]]))
    const fps = 1000 / g.minIntervalMs(104)
    expect(fps).toBeGreaterThan(2)
    expect(fps).toBeLessThan(3)
    expect(g.throttledCount()).toBe(1)
  })

  it('never goes below minThrottledFps', () => {
    const g = new FrameGovernor(cfg)
    g.update(new Map([[104, { avgInferenceMs: 5000, configuredFps: 0, decodeFps: 25 }]]))
    expect(1000 / g.minIntervalMs(104)).toBeCloseTo(2, 5)
  })

  it('splits the budget across active cameras', () => {
    const g = new FrameGovernor(cfg)
    const sample = { avgInferenceMs: 200, configuredFps: 0, decodeFps: 25 }
    g.update(
      new Map([
        [1, sample],
        [2, sample],
      ]),
    )
    // 800 ms/s each → 4fps each
    expect(1000 / g.minIntervalMs(1)).toBeCloseTo(4, 1)
  })

  it('honours an explicit configuredFps as the upper bound', () => {
    const g = new FrameGovernor(cfg)
    g.update(new Map([[1, { avgInferenceMs: 10, configuredFps: 8, decodeFps: 25 }]]))
    expect(1000 / g.minIntervalMs(1)).toBeCloseTo(8, 5)
  })

  it('returns 0 interval for unknown cameras (no gate)', () => {
    const g = new FrameGovernor(cfg)
    expect(g.minIntervalMs(999)).toBe(0)
  })
})
