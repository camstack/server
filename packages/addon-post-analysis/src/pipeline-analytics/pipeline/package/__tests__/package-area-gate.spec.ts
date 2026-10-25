/**
 * Package area gate — the ceiling that separates device 101's ONE recurring
 * false positive from every real parcel it has ever seen.
 *
 * The fixtures below are REAL boxes measured off the hub (2026-08-21 package
 * analysis, scratchpad/_pkg): 348/350 false detections were a single static
 * object — the streetlight's light wedge on the granite paving — at 7.96–9.47%
 * of the frame, scoring up to 0.877. The only true parcels measured sat at
 * 1.14% and 1.72%. CONFIDENCE does not separate them (true parcel: 0.885);
 * AREA does, with ~4× margin on either side of the 0.04 default.
 *
 * These tests are the guard the repo rules ask for: if a refactor ever lets
 * the light-wedge geometry back through, this file goes red.
 */

import { describe, expect, it } from 'vitest'
import { PACKAGE_DROP_DEFAULTS } from '../../../package-settings.js'
import { packageAreaVerdict } from '../package-area-gate.js'

/** Device 101's detection frame. */
const FRAME_W = 640
const FRAME_H = 360

/** The streetlight's light wedge on the granite paving — the object behind
 *  348/350 false detections (night, static, conf up to 0.877). 9.46% area. */
const LIGHT_WEDGE = { x: 104.5, y: 165.5, w: 271.3, h: 80.3 }
/** Same object, widest measured variant (2026-08-18 23:28, 9.47%). */
const LIGHT_WEDGE_WIDE = { x: 104, y: 164.7, w: 272.1, h: 80.2 }
/** The daylight doormat blob the same model produces (measured 2026-08-20
 *  18:15 footage, 9.5% area — sub-threshold at runtime but same geometry). */
const DOORMAT_BLOB = { x: 190, y: 240.5, w: 192.2, h: 113.9 }

/** The ONE true parcel measured through the whole pipeline (2026-08-18 13:41,
 *  conf 0.885 — HIGHER than every wedge FP). 1.14% area. */
const TRUE_PARCEL = { x: 263.1, y: 278.5, w: 59.2, h: 44.4 }
/** The missed 2026-08-20 18:15 delivery — box half-cropped at the frame's
 *  bottom edge, 1.72% area. */
const TRUE_PARCEL_EDGE = { x: 141.4, y: 303.8, w: 71.6, h: 55.5 }
/** An A5 flyer flat on the mat (~21×15cm at this scale ≈ 1% of frame). */
const A5_FLYER = { x: 260, y: 280, w: 64, h: 36 }

const MAX = PACKAGE_DROP_DEFAULTS.packageDropMaxBboxAreaFrac

function verdict(bbox: { x: number; y: number; w: number; h: number }) {
  return packageAreaVerdict({
    bbox,
    frameWidth: FRAME_W,
    frameHeight: FRAME_H,
    maxAreaFrac: MAX,
  })
}

describe('the measured false positive is rejected', () => {
  it('the light wedge (9.46% of frame) is over the ceiling', () => {
    const v = verdict(LIGHT_WEDGE)
    expect(v.ok).toBe(false)
    expect(v.areaFrac).toBeGreaterThan(MAX)
  })

  it('the widest measured wedge variant (9.47%) is over the ceiling', () => {
    expect(verdict(LIGHT_WEDGE_WIDE).ok).toBe(false)
  })

  it('the daylight doormat blob (9.5%) is over the ceiling', () => {
    expect(verdict(DOORMAT_BLOB).ok).toBe(false)
  })

  it('the whole measured FP band (7.96%–9.47%) is over the ceiling', () => {
    // Lower edge of the measured band, as a synthetic box.
    const lowBand = { x: 110, y: 170, w: 240, h: 76.4 } // ≈ 7.96%
    expect(verdict(lowBand).ok).toBe(false)
  })
})

describe('every real parcel measured passes', () => {
  it('the 2026-08-18 true parcel (1.14%) passes with ≥3× margin', () => {
    const v = verdict(TRUE_PARCEL)
    expect(v.ok).toBe(true)
    expect(v.areaFrac).toBeLessThan(MAX / 3)
  })

  it('the missed 2026-08-20 edge-of-frame parcel (1.72%) passes', () => {
    expect(verdict(TRUE_PARCEL_EDGE).ok).toBe(true)
  })

  it('an A5 flyer passes', () => {
    expect(verdict(A5_FLYER).ok).toBe(true)
  })
})

describe('edge behaviour', () => {
  it('reports the computed area fraction either way', () => {
    const v = verdict(TRUE_PARCEL)
    expect(v.areaFrac).toBeCloseTo((59.2 * 44.4) / (640 * 360), 5)
  })

  it('unknown frame dimensions never reject (the detector owns that case)', () => {
    const v = packageAreaVerdict({
      bbox: LIGHT_WEDGE,
      frameWidth: 0,
      frameHeight: 0,
      maxAreaFrac: MAX,
    })
    expect(v.ok).toBe(true)
    expect(v.areaFrac).toBe(0)
  })

  it('a ceiling of exactly the box area still passes (inclusive bound)', () => {
    const v = packageAreaVerdict({
      bbox: { x: 0, y: 0, w: 64, h: 36 },
      frameWidth: FRAME_W,
      frameHeight: FRAME_H,
      maxAreaFrac: (64 * 36) / (640 * 360),
    })
    expect(v.ok).toBe(true)
  })
})
