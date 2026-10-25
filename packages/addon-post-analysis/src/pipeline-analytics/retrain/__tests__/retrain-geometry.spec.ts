/**
 * Per-model geometry, derived from ONE canonical box.
 *
 * The property under test is not "the arithmetic is right" — it is that the
 * three derivations all start from the same stored rectangle and that none of
 * them can be silently wrong. Specifically:
 *
 *  - a box outside the zone crop comes back `null`, never a clamped rectangle
 *    sitting on the crop border (a clamped box is a WRONG label: it teaches the
 *    model that the subject ends where the crop ends);
 *  - the letterbox derivation is square-side agnostic, so nothing downstream
 *    has to know whether the model takes 640 or 1280;
 *  - the subject crop reports where the subject actually LANDS, which is not
 *    the centre when the padding was clipped by a frame edge.
 */
import { describe, expect, it } from 'vitest'
import {
  deriveLetterboxRect,
  deriveRetrainGeometry,
  deriveSubjectCropRect,
  deriveZoneCropRect,
} from '../retrain-geometry.js'

const CLOSE = 6

describe('deriveLetterboxRect', () => {
  it('shifts y by half the leftover on a 16:9 frame and leaves x alone', () => {
    // A 16:9 frame occupies the middle 9/16 of the square's height.
    const g = deriveLetterboxRect({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 1920, 1080)!
    const scaleY = 1080 / 1920
    expect(g.bbox.x).toBeCloseTo(0.25, CLOSE)
    expect(g.bbox.w).toBeCloseTo(0.5, CLOSE)
    expect(g.bbox.y).toBeCloseTo((1 - scaleY) / 2 + 0.5 * scaleY, CLOSE)
    expect(g.bbox.h).toBeCloseTo(0.25 * scaleY, CLOSE)
    expect(g.visibleFraction).toBe(1)
  })

  it('is the identity on an already-square frame', () => {
    const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }
    expect(deriveLetterboxRect(box, 640, 640)!.bbox).toEqual(box)
  })

  it('refuses a degenerate box and a frame with no dimensions', () => {
    expect(deriveLetterboxRect({ x: 0, y: 0, w: 0, h: 0.2 }, 1920, 1080)).toBeNull()
    expect(deriveLetterboxRect({ x: 0, y: 0, w: 0.2, h: 0.2 }, 0, 0)).toBeNull()
  })
})

describe('deriveZoneCropRect', () => {
  const zone = { x: 0.5, y: 0.5, w: 0.25, h: 0.25 }

  it('re-normalises a fully-contained box against the zone', () => {
    const g = deriveZoneCropRect({ x: 0.55, y: 0.55, w: 0.05, h: 0.05 }, zone)!
    expect(g.bbox.x).toBeCloseTo(0.2, CLOSE)
    expect(g.bbox.y).toBeCloseTo(0.2, CLOSE)
    expect(g.bbox.w).toBeCloseTo(0.2, CLOSE)
    expect(g.bbox.h).toBeCloseTo(0.2, CLOSE)
    expect(g.visibleFraction).toBeCloseTo(1, CLOSE)
  })

  it('reports how much of a partially-overlapping box survived', () => {
    // Half the box's width lies left of the zone.
    const g = deriveZoneCropRect({ x: 0.45, y: 0.55, w: 0.1, h: 0.05 }, zone)!
    expect(g.visibleFraction).toBeCloseTo(0.5, CLOSE)
    expect(g.bbox.x).toBeCloseTo(0, CLOSE)
  })

  it('returns null — never a clamped box — for a subject outside the zone', () => {
    expect(deriveZoneCropRect({ x: 0.05, y: 0.05, w: 0.1, h: 0.1 }, zone)).toBeNull()
  })
})

describe('deriveSubjectCropRect', () => {
  it('centres a subject that has room for its padding', () => {
    const g = deriveSubjectCropRect({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, 0.25)!
    // crop = [0.35, 0.65] on both axes → the subject is the middle 2/3.
    expect(g.bbox.x).toBeCloseTo(1 / 6, CLOSE)
    expect(g.bbox.w).toBeCloseTo(2 / 3, CLOSE)
  })

  it('reports a subject FLUSH to the edge when the padding was clipped', () => {
    const g = deriveSubjectCropRect({ x: 0, y: 0.4, w: 0.2, h: 0.2 }, 0.5)!
    expect(g.bbox.x).toBe(0)
    // Nothing to the left, half a box-width to the right → the subject is 2/3.
    expect(g.bbox.w).toBeCloseTo(2 / 3, CLOSE)
  })

  it('is the whole crop when there is no padding', () => {
    const g = deriveSubjectCropRect({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, 0)!
    expect(g.bbox.x).toBeCloseTo(0, CLOSE)
    expect(g.bbox.y).toBeCloseTo(0, CLOSE)
    expect(g.bbox.w).toBeCloseTo(1, CLOSE)
    expect(g.bbox.h).toBeCloseTo(1, CLOSE)
  })
})

describe('deriveRetrainGeometry', () => {
  it('dispatches to the same answer as the direct call, per target', () => {
    const box = { x: 0.55, y: 0.55, w: 0.05, h: 0.05 }
    expect(deriveRetrainGeometry(box, { kind: 'letterbox', frameWidth: 1920, frameHeight: 1080 })) //
      .toEqual(deriveLetterboxRect(box, 1920, 1080))
    const zone = { x: 0.5, y: 0.5, w: 0.25, h: 0.25 }
    expect(deriveRetrainGeometry(box, { kind: 'zone-crop', zone })).toEqual(
      deriveZoneCropRect(box, zone),
    )
    expect(deriveRetrainGeometry(box, { kind: 'subject-crop', padding: 0.2 })).toEqual(
      deriveSubjectCropRect(box, 0.2),
    )
  })
})
