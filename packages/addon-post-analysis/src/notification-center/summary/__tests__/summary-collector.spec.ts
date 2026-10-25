import { describe, expect, it } from 'vitest'
import { NcSummaryCollector, OPEN_TRACK_MAX_AGE_MS } from '../summary-collector.js'

describe('NcSummaryCollector', () => {
  it('opens a motion window on the first motion and extends it on later motion', () => {
    const c = new NcSummaryCollector()
    expect(c.refreshMotionWindow('r1', [636, 637])).toBeNull()
    c.observeMotion({ deviceId: 636, atMs: 1_000 })
    expect(c.refreshMotionWindow('r1', [636, 637])).toEqual({
      openedAtMs: 1_000,
      lastMotionMs: 1_000,
    })
    c.observeMotion({ deviceId: 637, atMs: 4_000 })
    expect(c.refreshMotionWindow('r1', [636, 637])).toEqual({
      openedAtMs: 1_000,
      lastMotionMs: 4_000,
    })
  })

  it('ignores motion on a camera the rule does not name', () => {
    const c = new NcSummaryCollector()
    c.observeMotion({ deviceId: 999, atMs: 1_000 })
    expect(c.refreshMotionWindow('r1', [636])).toBeNull()
  })

  it('is idempotent — refreshing twice never moves the window', () => {
    const c = new NcSummaryCollector()
    c.observeMotion({ deviceId: 636, atMs: 1_000 })
    const first = c.refreshMotionWindow('r1', [636])
    expect(c.refreshMotionWindow('r1', [636])).toEqual(first)
  })

  it('counts only the OPEN tracks that started inside the window', () => {
    const c = new NcSummaryCollector()
    c.observeMotion({ deviceId: 636, atMs: 500, trackId: 'before' })
    c.observeMotion({ deviceId: 636, atMs: 1_500, trackId: 'inside' })
    c.observeMotion({ deviceId: 999, atMs: 1_500, trackId: 'other-camera' })
    expect(c.openTrackCount([636], 1_000)).toBe(1)
    expect(c.openTrackIds([636], 1_000)).toEqual(['inside'])
  })

  it('a closed track leaves the barrier immediately', () => {
    const c = new NcSummaryCollector()
    c.observeMotion({ deviceId: 636, atMs: 1_500, trackId: 't1' })
    expect(c.openTrackCount([636], 1_000)).toBe(1)
    c.observeTrackClosed('t1')
    expect(c.openTrackCount([636], 1_000)).toBe(0)
  })

  it('a repeated observation of the same track keeps its ORIGINAL open time', () => {
    const c = new NcSummaryCollector()
    c.observeMotion({ deviceId: 636, atMs: 500, trackId: 't1' })
    c.observeMotion({ deviceId: 636, atMs: 9_000, trackId: 't1' })
    // Still outside a window that starts at 1_000 — a long track must not
    // migrate into a later window by being seen again.
    expect(c.openTrackCount([636], 1_000)).toBe(0)
  })

  it('sweeps tracks that never closed, and reports how many', () => {
    const c = new NcSummaryCollector()
    c.observeMotion({ deviceId: 636, atMs: 0, trackId: 'stuck' })
    c.observeMotion({ deviceId: 636, atMs: 0, trackId: 'stuck2' })
    expect(c.sweep(OPEN_TRACK_MAX_AGE_MS)).toBe(0)
    expect(c.sweep(OPEN_TRACK_MAX_AGE_MS + 1)).toBe(2)
    expect(c.stats().openTracks).toBe(0)
  })

  it('closing a window forgets it and the marks that could re-open it in the past', () => {
    const c = new NcSummaryCollector()
    c.observeMotion({ deviceId: 636, atMs: 1_000 })
    c.refreshMotionWindow('r1', [636])
    c.closeMotionWindow('r1', 2_000)
    expect(c.motionWindow('r1')).toBeNull()
    expect(c.refreshMotionWindow('r1', [636])).toBeNull()
    // …but new motion opens the NEXT window straight away.
    c.observeMotion({ deviceId: 636, atMs: 3_000 })
    expect(c.refreshMotionWindow('r1', [636])?.openedAtMs).toBe(3_000)
  })

  it('a camera still busy at the close re-opens the next window at once', () => {
    const c = new NcSummaryCollector()
    c.observeMotion({ deviceId: 636, atMs: 5_000 })
    c.refreshMotionWindow('r1', [636])
    // The window closes at 3_000 (earlier than the last motion): the mark
    // survives, so the next window opens on it rather than waiting.
    c.closeMotionWindow('r1', 3_000)
    expect(c.refreshMotionWindow('r1', [636])?.openedAtMs).toBe(5_000)
  })

  it('retainRules drops a deleted rule window', () => {
    const c = new NcSummaryCollector()
    c.observeMotion({ deviceId: 636, atMs: 1_000 })
    c.refreshMotionWindow('r1', [636])
    c.retainRules(['r2'])
    expect(c.motionWindow('r1')).toBeNull()
  })
})
