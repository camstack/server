import { describe, it, expect } from 'vitest'
import { MediaCaptureLogAggregator, type MediaCaptureCounts } from '../media-capture-log.js'

const COUNTS: MediaCaptureCounts = {
  events: 1,
  trackFrames: 0,
  snapshots: 2,
  faceCrops: 0,
  plateCrops: 0,
}

describe('MediaCaptureLogAggregator', () => {
  it('accumulates within the window and returns null', () => {
    const agg = new MediaCaptureLogAggregator(60_000)
    expect(agg.note(9, COUNTS, 1_000)).toBeNull()
    expect(agg.note(9, COUNTS, 30_000)).toBeNull()
  })

  it('flushes per-counter SUMS + frame count once the window elapses', () => {
    const agg = new MediaCaptureLogAggregator(60_000)
    agg.note(9, COUNTS, 1_000)
    agg.note(9, { ...COUNTS, faceCrops: 3 }, 30_000)
    const out = agg.note(9, COUNTS, 61_001)
    expect(out).toEqual({
      frames: 3,
      windowMs: 60_001,
      sums: { events: 3, trackFrames: 0, snapshots: 6, faceCrops: 3, plateCrops: 0 },
    })
    // window restarted — next note accumulates fresh
    expect(agg.note(9, COUNTS, 62_000)).toBeNull()
  })

  it('keeps devices independent', () => {
    const agg = new MediaCaptureLogAggregator(60_000)
    agg.note(9, COUNTS, 1_000)
    expect(agg.note(7, COUNTS, 61_001)).toBeNull() // device 7's window just started
  })

  it('flush() returns the pending aggregate and clears state', () => {
    const agg = new MediaCaptureLogAggregator(60_000)
    agg.note(9, COUNTS, 1_000)
    agg.note(9, COUNTS, 2_000)
    const out = agg.flush(9, 5_000)
    expect(out).toEqual({
      frames: 2,
      windowMs: 4_000,
      sums: { events: 2, trackFrames: 0, snapshots: 4, faceCrops: 0, plateCrops: 0 },
    })
    expect(agg.flush(9, 6_000)).toBeNull()
  })
})
