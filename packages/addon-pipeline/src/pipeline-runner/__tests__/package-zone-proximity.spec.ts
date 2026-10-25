/**
 * package-zone-proximity — what "motion near the package zone" means.
 *
 * Geometry is device 101's real doormat: bbox (104.5, 164.4, 271, 78) on a
 * 640×360 detection frame, measured 2026-08-13.
 */
import { describe, expect, it } from 'vitest'
import {
  dilateZoneBox,
  motionNearPackageZone,
  PACKAGE_ZONE_DILATION,
  packageZoneUnion,
  type NormalizedBox,
} from '../package-zone-proximity.js'

const FRAME_W = 640
const FRAME_H = 360
/** The doormat, normalised. */
const DOORMAT: NormalizedBox = {
  x: 104.5 / FRAME_W,
  y: 164.4 / FRAME_H,
  w: 271 / FRAME_W,
  h: 78 / FRAME_H,
}

function region(x: number, y: number, w: number, h: number): { bbox: NormalizedBox } {
  return { bbox: { x, y, w, h } }
}

/** `zoneUnion` is passed positionally with NO default — an explicit
 *  `undefined` must reach the function as unknown geometry, and a default
 *  parameter would quietly substitute the doormat for it. */
function near(
  regions: readonly { bbox: NormalizedBox }[],
  zoneUnion: NormalizedBox | undefined = DOORMAT,
): boolean {
  return motionNearPackageZone({ regions, frameWidth: FRAME_W, frameHeight: FRAME_H, zoneUnion })
}

function nearUnknownZone(regions: readonly { bbox: NormalizedBox }[]): boolean {
  return motionNearPackageZone({
    regions,
    frameWidth: FRAME_W,
    frameHeight: FRAME_H,
    zoneUnion: undefined,
  })
}

describe('dilateZoneBox', () => {
  it('grows by the declared fraction of the box on every side', () => {
    const box: NormalizedBox = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }
    const out = dilateZoneBox(box, 0.5)
    expect(out.x).toBeCloseTo(0.3)
    expect(out.y).toBeCloseTo(0.3)
    expect(out.w).toBeCloseTo(0.4)
    expect(out.h).toBeCloseTo(0.4)
  })

  it('clamps to the frame instead of producing coordinates off it', () => {
    const out = dilateZoneBox({ x: 0, y: 0.9, w: 0.2, h: 0.1 }, 1)
    expect(out.x).toBe(0)
    expect(out.y).toBeCloseTo(0.8)
    expect(out.y + out.h).toBeLessThanOrEqual(1)
  })

  it('the shipped dilation is the one the doc explains', () => {
    expect(PACKAGE_ZONE_DILATION).toBe(0.5)
  })
})

describe('motionNearPackageZone', () => {
  it('motion ON the doormat counts', () => {
    expect(near([region(150, 170, 60, 60)])).toBe(true)
  })

  it('a courier standing BESIDE the mat counts — the whole point of dilating', () => {
    // A person 40px wide immediately left of the mat (mat starts at x=104.5).
    expect(near([region(60, 150, 40, 120)])).toBe(true)
  })

  it('motion at the far side of the street does NOT count', () => {
    // Top-right corner, nowhere near the doorstep.
    expect(near([region(560, 0, 60, 40)])).toBe(false)
  })

  it('one qualifying region among many is enough', () => {
    expect(near([region(560, 0, 60, 40), region(150, 170, 60, 60)])).toBe(true)
  })

  it('no motion at all is never near', () => {
    expect(near([])).toBe(false)
    expect(nearUnknownZone([])).toBe(false)
  })

  it('UNKNOWN zone geometry fails OPEN — any motion counts', () => {
    // D49: a failed geometry read must not be able to silence the feature. It
    // degrades to exactly the whole-frame signal this replaced.
    expect(nearUnknownZone([region(560, 0, 60, 40)])).toBe(true)
  })

  it('unusable frame dimensions fail open too', () => {
    expect(
      motionNearPackageZone({
        regions: [region(560, 0, 60, 40)],
        frameWidth: 0,
        frameHeight: 0,
        zoneUnion: DOORMAT,
      }),
    ).toBe(true)
  })
})

describe('packageZoneUnion', () => {
  it('is the bounding box of every polygon', () => {
    const union = packageZoneUnion([
      [
        { x: 0.1, y: 0.2 },
        { x: 0.3, y: 0.2 },
        { x: 0.3, y: 0.4 },
      ],
      [
        { x: 0.5, y: 0.1 },
        { x: 0.6, y: 0.5 },
      ],
    ])
    expect(union).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.4 })
  })

  it('returns undefined — NOT an empty box — when there is no geometry', () => {
    // The difference matters: undefined means "unknown" and fails open, an
    // empty box would mean "nothing is ever near" and fail closed.
    expect(packageZoneUnion([])).toBeUndefined()
    expect(packageZoneUnion([[]])).toBeUndefined()
  })

  it('returns undefined for a degenerate (zero-area) union', () => {
    expect(
      packageZoneUnion([
        [
          { x: 0.4, y: 0.4 },
          { x: 0.4, y: 0.4 },
        ],
      ]),
    ).toBeUndefined()
  })
})
