import { describe, expect, it } from 'vitest'
import {
  isPlausibleThumbnailBox,
  isPlausibleRetryBox,
  NEAR_FULL_FRAME_AREA,
  RETRY_MIN_FRACTION_OF_BEST,
} from '../best-thumbnail-guard.js'

const FW = 640
const FH = 360

describe('isPlausibleThumbnailBox', () => {
  it('accepts a normal subject box (small fraction of the frame)', () => {
    expect(isPlausibleThumbnailBox({ w: 120, h: 90 }, FW, FH)).toBe(true)
  })

  it('accepts a large close-up subject still under the threshold', () => {
    // ~64% of the frame — a genuine large subject, must NOT be rejected.
    expect(isPlausibleThumbnailBox({ w: 512, h: 288 }, FW, FH)).toBe(true)
  })

  it('rejects a box exploded to (near-)full-frame (envelope void)', () => {
    // 95% × 98% of the frame ≈ 0.93 area → rejected.
    expect(isPlausibleThumbnailBox({ w: FW * 0.95, h: FH * 0.98 }, FW, FH)).toBe(false)
  })

  it('rejects the full frame', () => {
    expect(isPlausibleThumbnailBox({ w: FW, h: FH }, FW, FH)).toBe(false)
  })

  it('is exactly at the boundary: area === threshold is rejected (strict <)', () => {
    // Construct a box whose area fraction is exactly NEAR_FULL_FRAME_AREA
    // while staying BELOW the full-dimension guard (h = 90% of the frame —
    // the 2026-07-23 rule rejects >=95%-of-a-dimension spans separately).
    const h = FH * 0.9
    const w = (FW * NEAR_FULL_FRAME_AREA) / 0.9
    expect(isPlausibleThumbnailBox({ w, h }, FW, FH)).toBe(false)
    // A hair under the area threshold is accepted.
    expect(isPlausibleThumbnailBox({ w: w - 5, h }, FW, FH)).toBe(true)
  })

  it('treats degenerate frame dimensions as plausible (no info to reject on)', () => {
    expect(isPlausibleThumbnailBox({ w: 100, h: 100 }, 0, 0)).toBe(true)
  })
})

describe('isPlausibleRetryBox (#27-A degenerate-retry gate)', () => {
  it('is plausible when there is no best-seen reference (nothing to compare)', () => {
    expect(isPlausibleRetryBox({ w: 26, h: 20 }, null)).toBe(true)
  })

  it('is plausible when the best-seen box is degenerate (zero area)', () => {
    expect(isPlausibleRetryBox({ w: 26, h: 20 }, { w: 0, h: 0 })).toBe(true)
    expect(isPlausibleRetryBox({ w: 26, h: 20 }, { w: 10, h: 0 })).toBe(true)
  })

  it('accepts a retry box comparable to the best-seen subject', () => {
    // Same size → fraction 1 ≥ 0.45.
    expect(isPlausibleRetryBox({ w: 78, h: 60 }, { w: 78, h: 60 })).toBe(true)
    // Modest breathing (~0.64 area) is fine.
    expect(isPlausibleRetryBox({ w: 62, h: 48 }, { w: 78, h: 60 })).toBe(true)
  })

  it('rejects the observed live case: car born 78px, retried at 26px after the lease warmed', () => {
    // Proportional shrink 78→26 per side ⇒ area fraction ≈ 0.11 < 0.45.
    expect(isPlausibleRetryBox({ w: 26, h: 20 }, { w: 78, h: 60 })).toBe(false)
  })

  it('boundary: exactly the minimum fraction is accepted (≥, not >)', () => {
    // best 100×100 = 10 000; current area exactly 0.45 × 10 000 = 4 500.
    expect(isPlausibleRetryBox({ w: 45, h: 100 }, { w: 100, h: 100 })).toBe(true)
    expect(isPlausibleRetryBox({ w: 44.9, h: 100 }, { w: 100, h: 100 })).toBe(false)
  })

  it('honours a caller-supplied fraction override', () => {
    expect(isPlausibleRetryBox({ w: 50, h: 50 }, { w: 100, h: 100 }, 0.25)).toBe(true)
    expect(isPlausibleRetryBox({ w: 50, h: 50 }, { w: 100, h: 100 }, 0.5)).toBe(false)
  })

  it('never affects a genuine new-best capture (documented: caller bypasses on isNewBest)', () => {
    // The gate itself has no isNewBest input — this locks the default export
    // value the caller composes with (`isNewBest || isPlausibleRetryBox(...)`).
    expect(RETRY_MIN_FRACTION_OF_BEST).toBe(0.45)
  })
})

// ── 2026-07-23: full-column / full-row artifact rejection ────────────────────
import { NEAR_FULL_DIMENSION } from '../best-thumbnail-guard.js'

describe('isPlausibleThumbnailBox full-dimension guard', () => {
  it('rejects a full-height column (garden-wall false positive, h=353/360)', () => {
    expect(isPlausibleThumbnailBox({ w: 111, h: 353 }, 640, 360)).toBe(false)
  })
  it('rejects a full-width row', () => {
    expect(isPlausibleThumbnailBox({ w: 620, h: 40 }, 640, 360)).toBe(false)
  })
  it('keeps a tall REAL subject under the threshold', () => {
    expect(isPlausibleThumbnailBox({ w: 80, h: 300 }, 640, 360)).toBe(true)
    expect(NEAR_FULL_DIMENSION).toBeGreaterThan(300 / 360)
  })
})

// ── 2026-07-23: score-aware override (real full-frame close subjects) ────────
import { NEAR_FULL_FRAME_CONFIDENT_SCORE } from '../best-thumbnail-guard.js'

describe('isPlausibleThumbnailBox score-aware override', () => {
  it('accepts a HIGH-confidence full-frame box (dev101 driveway car, 0,0,640x341 @0.6)', () => {
    expect(isPlausibleThumbnailBox({ w: 640, h: 341.5 }, 640, 360, 0.6)).toBe(true)
  })
  it('still rejects the LOW-confidence artifact (garden wall @0.04)', () => {
    expect(isPlausibleThumbnailBox({ w: 111, h: 353 }, 640, 360, 0.04)).toBe(false)
    expect(isPlausibleThumbnailBox({ w: 640, h: 341.5 }, 640, 360, 0.04)).toBe(false)
  })
  it('score-less callers keep the strict size-only guard (stationary promotion)', () => {
    expect(isPlausibleThumbnailBox({ w: 640, h: 341.5 }, 640, 360)).toBe(false)
  })
  it('boundary: exactly the confident score passes; a hair under does not', () => {
    const box = { w: 640, h: 341.5 }
    expect(isPlausibleThumbnailBox(box, 640, 360, NEAR_FULL_FRAME_CONFIDENT_SCORE)).toBe(true)
    expect(isPlausibleThumbnailBox(box, 640, 360, NEAR_FULL_FRAME_CONFIDENT_SCORE - 0.01)).toBe(
      false,
    )
  })
})
