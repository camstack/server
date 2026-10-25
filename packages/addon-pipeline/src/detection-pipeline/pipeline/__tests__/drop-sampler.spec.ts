import { describe, it, expect } from 'vitest'
import { DropSampler } from '../drop-sampler.js'

/**
 * The guard must keep leaving a trace of what it drops — that rule cost this
 * repo two outages — while not writing dozens of lines a second, which is what
 * device 101's standing full-frame phantom made it do on 2026-08-02.
 */
describe('DropSampler', () => {
  it('logs the first sighting in full — the example is what makes it actionable', () => {
    const s = new DropSampler(60_000, () => 0)
    expect(s.record(101, 'vehicle')).toEqual({ logExample: true, summaryCount: null })
  })

  it('goes quiet after the first, instead of repeating it', () => {
    let now = 0
    const s = new DropSampler(60_000, () => now)
    s.record(101, 'vehicle')
    for (let i = 0; i < 500; i++) {
      now += 30 // ~33/s, the observed rate
      expect(s.record(101, 'vehicle')).toEqual({ logExample: false, summaryCount: null })
    }
  })

  it('reports the RATE once per interval — the count is what was actually wanted', () => {
    let now = 0
    const s = new DropSampler(60_000, () => now)
    s.record(101, 'vehicle')
    for (let i = 0; i < 9; i++) {
      now += 1_000
      s.record(101, 'vehicle')
    }
    now += 60_000
    const out = s.record(101, 'vehicle')
    expect(out.logExample).toBe(false)
    expect(out.summaryCount).toBe(10)
  })

  it('counts restart after a summary, so the next one is not cumulative', () => {
    let now = 0
    const s = new DropSampler(1_000, () => now)
    s.record(1, 'vehicle')
    now += 2_000
    expect(s.record(1, 'vehicle').summaryCount).toBe(1)
    now += 2_000
    expect(s.record(1, 'vehicle').summaryCount).toBe(1)
  })

  it('a phantom on one camera never masks a NEW one on another', () => {
    // The reason this is keyed per (device, class) and not globally: a single
    // counter would swallow the first sighting on a second camera, which is
    // exactly the line worth having.
    let now = 0
    const s = new DropSampler(60_000, () => now)
    s.record(101, 'vehicle')
    for (let i = 0; i < 100; i++) {
      now += 30
      s.record(101, 'vehicle')
    }
    expect(s.record(102, 'vehicle').logExample).toBe(true)
    expect(s.record(101, 'person').logExample).toBe(true)
  })
})
