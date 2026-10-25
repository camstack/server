import { describe, it, expect } from 'vitest'
import { BestDetectionTracker } from '../best-detection-tracker.js'

describe('BestDetectionTracker', () => {
  it('first observation of a track is always the best', () => {
    const t = new BestDetectionTracker()
    expect(t.observe('a', 0.4, 100)).toBe(true)
    expect(t.peak('a')).toEqual({ confidence: 0.4, atMs: 100 })
  })

  describe('face params (hysteresis 0, no rate-limit) — strict highest wins', () => {
    it('accepts any strictly-higher confidence, rejects equal/lower', () => {
      const t = new BestDetectionTracker()
      expect(t.observe('a', 0.5, 100)).toBe(true)
      expect(t.observe('a', 0.7, 150)).toBe(true) // higher → new best
      expect(t.observe('a', 0.7, 200)).toBe(false) // equal → not a new best
      expect(t.observe('a', 0.6, 250)).toBe(false) // lower → not a new best
      expect(t.peak('a')).toEqual({ confidence: 0.7, atMs: 150 })
    })

    it('tracks are independent', () => {
      const t = new BestDetectionTracker()
      expect(t.observe('a', 0.9, 1)).toBe(true)
      expect(t.observe('b', 0.2, 1)).toBe(true) // b's first — best regardless of a
    })
  })

  describe('best-frame params (hysteresis + rate-limit)', () => {
    it('requires beating the peak by MORE than the hysteresis margin', () => {
      const t = new BestDetectionTracker({ hysteresis: 0.05, minGapMs: 0 })
      expect(t.observe('a', 0.5, 100)).toBe(true)
      expect(t.observe('a', 0.54, 200)).toBe(false) // +0.04 ≤ margin
      expect(t.observe('a', 0.56, 300)).toBe(true) // +0.06 > margin
    })

    it('rate-limits accepted bests by minGapMs', () => {
      const t = new BestDetectionTracker({ hysteresis: 0, minGapMs: 2000 })
      expect(t.observe('a', 0.5, 1000)).toBe(true)
      expect(t.observe('a', 0.9, 1500)).toBe(false) // higher, but only 500ms later
      expect(t.observe('a', 0.9, 3000)).toBe(true) // 2000ms after the held peak
    })
  })

  describe('edge-aware best frame (optional edgeClear tier)', () => {
    it('an edge-clear observation beats a held edge-touching peak even at LOWER confidence', () => {
      const t = new BestDetectionTracker()
      expect(t.observe('a', 0.9, 100, false)).toBe(true) // touching peak
      // Lower confidence but edge-clear → tier upgrade wins ALWAYS.
      expect(t.observe('a', 0.3, 200, true)).toBe(true)
      expect(t.peak('a')).toEqual({ confidence: 0.3, atMs: 200 })
    })

    it('an edge-touching observation NEVER replaces a held edge-clear peak, even at higher confidence', () => {
      const t = new BestDetectionTracker()
      expect(t.observe('a', 0.4, 100, true)).toBe(true) // clear peak
      expect(t.observe('a', 0.99, 200, false)).toBe(false) // touching → rejected
      expect(t.peak('a')).toEqual({ confidence: 0.4, atMs: 100 })
    })

    it('the tier upgrade (touching → clear) bypasses hysteresis and minGap', () => {
      const t = new BestDetectionTracker({ hysteresis: 0.05, minGapMs: 5000 })
      expect(t.observe('a', 0.8, 1000, false)).toBe(true) // touching peak
      // Only 100ms later and lower confidence, but a clear frame is taken now.
      expect(t.observe('a', 0.5, 1100, true)).toBe(true)
    })

    it('within the same (clear) tier still respects confidence + hysteresis + minGap', () => {
      const t = new BestDetectionTracker({ hysteresis: 0.05, minGapMs: 2000 })
      expect(t.observe('a', 0.5, 1000, true)).toBe(true)
      expect(t.observe('a', 0.54, 1500, true)).toBe(false) // +0.04 ≤ margin
      expect(t.observe('a', 0.9, 1500, true)).toBe(false) // beats margin but < minGap
      expect(t.observe('a', 0.9, 3000, true)).toBe(true) // margin + minGap satisfied
    })

    it('omitting edgeClear preserves pure-confidence behaviour (default clear tier)', () => {
      const t = new BestDetectionTracker()
      expect(t.observe('a', 0.5, 100)).toBe(true)
      expect(t.observe('a', 0.7, 150)).toBe(true)
      expect(t.observe('a', 0.7, 200)).toBe(false)
    })
  })

  describe('centering tie-break (#27-D)', () => {
    it('a better-centred, near-equal-confidence same-tier frame becomes the new best', () => {
      const t = new BestDetectionTracker({ hysteresis: 0.05, minGapMs: 0 })
      // edge-clear=true both; confidence within hysteresis; centre 0.3 → 0.9.
      expect(t.observe('a', 0.5, 100, true, 0.3)).toBe(true)
      expect(t.observe('a', 0.52, 200, true, 0.9)).toBe(true)
    })

    it('a worse-centred, near-equal-confidence frame does NOT overturn the peak', () => {
      const t = new BestDetectionTracker({ hysteresis: 0.05, minGapMs: 0 })
      expect(t.observe('a', 0.5, 100, true, 0.9)).toBe(true)
      expect(t.observe('a', 0.52, 200, true, 0.3)).toBe(false)
    })

    it('omitting centerScore preserves pure edge/confidence behaviour', () => {
      const t = new BestDetectionTracker({ hysteresis: 0.05, minGapMs: 0 })
      expect(t.observe('a', 0.5, 100, true)).toBe(true)
      expect(t.observe('a', 0.52, 200, true)).toBe(false) // within hysteresis, no tie-break
    })
  })

  describe('edge-containment factor (6th arg)', () => {
    it('a fully-contained frame is NOT overturned by a border-clipped, near-equal frame', () => {
      const t = new BestDetectionTracker({ hysteresis: 0.05, minGapMs: 0 })
      // Held peak: contained (containment 1) at 0.7. Same touching tier both.
      expect(t.observe('a', 0.7, 100, false, undefined, 1)).toBe(true)
      // Clipped candidate slightly higher raw confidence but low containment.
      expect(t.observe('a', 0.72, 200, false, undefined, 0.6)).toBe(false)
      expect(t.peak('a')).toEqual({ confidence: 0.7, atMs: 100 })
    })

    it('a contained candidate overturns a held clipped peak of near-equal confidence', () => {
      const t = new BestDetectionTracker({ hysteresis: 0.05, minGapMs: 0 })
      expect(t.observe('a', 0.72, 100, false, undefined, 0.6)).toBe(true)
      expect(t.observe('a', 0.7, 200, false, undefined, 1)).toBe(true)
      expect(t.peak('a')).toEqual({ confidence: 0.7, atMs: 200 })
    })

    it('a decisively higher-confidence clipped candidate still wins', () => {
      const t = new BestDetectionTracker({ hysteresis: 0.05, minGapMs: 0 })
      expect(t.observe('a', 0.5, 100, false, undefined, 1)).toBe(true)
      expect(t.observe('a', 0.95, 200, false, undefined, 0.65)).toBe(true)
      expect(t.peak('a')).toEqual({ confidence: 0.95, atMs: 200 })
    })

    it('omitting containment preserves pure edge/confidence behaviour', () => {
      const t = new BestDetectionTracker({ hysteresis: 0.05, minGapMs: 0 })
      expect(t.observe('a', 0.5, 100, false)).toBe(true)
      expect(t.observe('a', 0.7, 200, false)).toBe(true)
    })
  })

  it('delete + clear drop held peaks', () => {
    const t = new BestDetectionTracker()
    t.observe('a', 0.5, 1)
    t.observe('b', 0.5, 1)
    t.delete('a')
    expect(t.peak('a')).toBeUndefined()
    expect(t.observe('a', 0.1, 2)).toBe(true) // treated as a first sighting again
    t.clear()
    expect(t.peak('b')).toBeUndefined()
  })
})

// ── 2026-07-22: decisive-improvement bypass of the capture rate limit ────────
import { BestDetectionTracker as TrackerWithSize } from '../best-detection-tracker.js'

describe('BestDetectionTracker decisive-size bypass', () => {
  it('a decisively bigger same-tier view is accepted INSIDE minGapMs', () => {
    const tracker = new TrackerWithSize({ hysteresis: 0.05, minGapMs: 2_000 })
    // Birth: small distant subject, edge-clear.
    expect(tracker.observe('t', 0.85, 1_000, true, 0.5, 1, 0.3)).toBe(true)
    // 800ms later (inside minGap): same confidence, subject 2.5x closer.
    expect(tracker.observe('t', 0.85, 1_800, true, 0.5, 1, 0.8)).toBe(true)
  })

  it('a modest improvement still respects minGapMs', () => {
    const tracker = new TrackerWithSize({ hysteresis: 0.05, minGapMs: 2_000 })
    expect(tracker.observe('t', 0.7, 1_000, true, 0.5, 1, 0.5)).toBe(true)
    // +0.08 confidence at same size: beats hysteresis but NOT decisive → gated.
    expect(tracker.observe('t', 0.78, 1_500, true, 0.5, 1, 0.5)).toBe(false)
    // Same improvement after the gap → accepted.
    expect(tracker.observe('t', 0.78, 3_100, true, 0.5, 1, 0.5)).toBe(true)
  })
})

describe('square-containment tier (8th observe arg, 2026-08-21)', () => {
  it('a contained candidate replaces an evicted peak, bypassing hysteresis + minGap', () => {
    const t = new BestDetectionTracker({ hysteresis: 0.05, minGapMs: 2000 })
    expect(t.observe('a', 0.9, 1000, true, 0.5, 1, 0.5, 0.08)).toBe(true)
    // Lower confidence, inside the rate window — the tier upgrade takes it.
    expect(t.observe('a', 0.4, 1500, true, 0.5, 1, 0.5, 1)).toBe(true)
  })

  it('an evicted candidate never replaces a contained peak', () => {
    const t = new BestDetectionTracker({ hysteresis: 0.05, minGapMs: 0 })
    expect(t.observe('a', 0.4, 1000, true, 0.5, 1, 0.5, 1)).toBe(true)
    expect(t.observe('a', 0.95, 4000, true, 0.5, 1, 0.5, 0.08)).toBe(false)
  })

  it('a non-edge-aware policy ignores squareFraction (confidence only)', () => {
    const t = new BestDetectionTracker({ edgeAware: false })
    expect(t.observe('a', 0.5, 1000, true, 0.5, 1, 0.5, 0.08)).toBe(true)
    expect(t.observe('a', 0.6, 2000, true, 0.5, 1, 0.5, 1)).toBe(true) // higher conf wins
    expect(t.observe('a', 0.4, 3000, true, 0.5, 1, 0.5, 1)).toBe(false) // tier input ignored
  })
})

describe('semantic tier (9th observe arg + markSemantic, 2026-08-21)', () => {
  it('a semantic observation upgrades the peak, bypassing hysteresis + minGap', () => {
    const t = new BestDetectionTracker({ hysteresis: 0.05, minGapMs: 2_000 })
    expect(t.observe('a', 0.9, 0, true, undefined, undefined, undefined, undefined, false)).toBe(
      true,
    )
    // Inside the rate window, lower confidence — the semantic tier wins anyway.
    expect(t.observe('a', 0.4, 500, true, undefined, undefined, undefined, undefined, true)).toBe(
      true,
    )
    expect(t.peak('a')?.confidence).toBe(0.4)
  })

  it('a non-semantic observation never displaces a held semantic peak', () => {
    const t = new BestDetectionTracker({ hysteresis: 0, minGapMs: 0 })
    expect(t.observe('a', 0.4, 0, true, undefined, undefined, undefined, undefined, true)).toBe(
      true,
    )
    expect(
      t.observe('a', 0.99, 1_000, true, undefined, undefined, undefined, undefined, false),
    ).toBe(false)
    expect(t.peak('a')?.confidence).toBe(0.4)
  })

  it('square containment stays ABOVE semantic in the tracker too', () => {
    const t = new BestDetectionTracker({ hysteresis: 0, minGapMs: 0 })
    // Held: square-contained, non-semantic.
    expect(t.observe('a', 0.5, 0, true, undefined, undefined, undefined, 1, false)).toBe(true)
    // Candidate: semantic but square-EVICTED — must not win.
    expect(t.observe('a', 0.9, 1, true, undefined, undefined, undefined, 0.1, true)).toBe(false)
    expect(t.peak('a')?.confidence).toBe(0.5)
  })

  it('markSemantic stamps the HELD peak so later non-semantic frames cannot displace it', () => {
    const t = new BestDetectionTracker({ hysteresis: 0, minGapMs: 0 })
    expect(t.observe('a', 0.5, 0, true)).toBe(true)
    expect(t.markSemantic('a')).toBe(true)
    expect(t.observe('a', 0.99, 1_000, true)).toBe(false)
    expect(t.peak('a')?.confidence).toBe(0.5)
  })

  it('markSemantic on an unknown track is a no-op that says so', () => {
    const t = new BestDetectionTracker()
    expect(t.markSemantic('missing')).toBe(false)
  })

  it('a semanticAware:false policy IGNORES the semantic input (declaration enforced)', () => {
    const t = new BestDetectionTracker({
      hysteresis: 0,
      minGapMs: 0,
      edgeAware: false,
      sizeAware: false,
      semanticAware: false,
    })
    expect(
      t.observe('a', 0.9, 0, undefined, undefined, undefined, undefined, undefined, false),
    ).toBe(true)
    expect(
      t.observe('a', 0.4, 1, undefined, undefined, undefined, undefined, undefined, true),
    ).toBe(false)
    expect(t.peak('a')?.confidence).toBe(0.9)
  })

  it('delete drops the semantic stamp with the peak', () => {
    const t = new BestDetectionTracker()
    t.observe('a', 0.5, 0, true, undefined, undefined, undefined, undefined, true)
    t.delete('a')
    // Re-opened track: a plain non-semantic observation is the new best again.
    expect(t.observe('a', 0.2, 1, true)).toBe(true)
    expect(t.observe('a', 0.3, 2, true)).toBe(true)
  })
})
