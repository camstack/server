/**
 * Motion-crop dispatch — the measured recipe, per camera (D396).
 *
 * The shipped recovery pass gates on an UNCOVERED motion region: a region a
 * full-frame box already accounts for is skipped, because the pass was built
 * to find a subject NEXT TO one the detector already sees. The measurement on
 * camera 101 says the cheaper question is better: detect on every moving
 * region, tracked boxes INCLUDED as seeds rather than as exclusions — recall
 * at the animal floor 24% full-frame, 42% on motion-derived crops, 74% with
 * the motion area bar lowered.
 *
 * These tests pin the region rule, the containment dedupe, the cap, and the
 * crop-only class floor that removes the two night-IR false positives the
 * quiet-footage arm produced (`vehicle 0.749`, `person 0.701`) — and pin that
 * it does NOT touch `animal`, which produced zero false positives at any gate.
 *
 * The selector is per camera and defaults OFF, so a deployment changes nothing
 * until a camera is moved.
 */

import type { ObjectDetection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  applyCropClassFloors,
  CROP_CLASS_FLOORS,
  MOTION_CROP_DISPATCH_KEY,
  MOTION_CROP_MAX_REGIONS,
  MOTION_CROP_MOTION_PAD,
  MOTION_CROP_TRACKED_PAD,
  planMotionCropRegions,
  planMotionCrops,
  readRecoveryRecipe,
  readRecoveryRecipeForSteps,
} from '../motion-crop-plan.js'
import { RECOVERY_CROP_MIN_SIDE_PX } from '../small-subject-recovery.js'

const NATIVE = { width: 3840, height: 2160 }

function det(
  id: string,
  macroClass: string,
  score: number,
  bbox = { x: 100, y: 100, width: 200, height: 200 },
): ObjectDetection {
  return { id, kind: 'first-level', macroClass, score, labels: [], bbox }
}

function near(actual: number, expected: number, tolerance = 1e-9): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance)
}

describe('readRecoveryRecipe — per-camera opt-in, default off', () => {
  it('is the shipped uncovered-region rule when the camera has no setting', () => {
    expect(readRecoveryRecipe(undefined)).toBe('uncovered-region')
    expect(readRecoveryRecipe({})).toBe('uncovered-region')
  })

  it('is the shipped rule when the setting is explicitly false', () => {
    expect(readRecoveryRecipe({ [MOTION_CROP_DISPATCH_KEY]: false })).toBe('uncovered-region')
  })

  it('selects the measured recipe only on an explicit true', () => {
    expect(readRecoveryRecipe({ [MOTION_CROP_DISPATCH_KEY]: true })).toBe('motion-crop')
  })

  it('treats a non-boolean value as unset rather than as truthy', () => {
    expect(readRecoveryRecipe({ [MOTION_CROP_DISPATCH_KEY]: 'yes' })).toBe('uncovered-region')
    expect(readRecoveryRecipe({ [MOTION_CROP_DISPATCH_KEY]: 1 })).toBe('uncovered-region')
  })
})

describe('readRecoveryRecipeForSteps — where the per-camera value is read from', () => {
  it('reads the ENABLED first-level detector own settings', () => {
    expect(
      readRecoveryRecipeForSteps([
        {
          addonId: 'object-detection',
          enabled: true,
          settings: { [MOTION_CROP_DISPATCH_KEY]: true },
        },
      ]),
    ).toBe('motion-crop')
  })

  it('ignores a DISABLED detector — a camera not detecting runs no second pass either', () => {
    expect(
      readRecoveryRecipeForSteps([
        {
          addonId: 'object-detection',
          enabled: false,
          settings: { [MOTION_CROP_DISPATCH_KEY]: true },
        },
      ]),
    ).toBe('uncovered-region')
  })

  it('ignores the setting on another step', () => {
    expect(
      readRecoveryRecipeForSteps([
        {
          addonId: 'package-detection',
          enabled: true,
          settings: { [MOTION_CROP_DISPATCH_KEY]: true },
        },
        { addonId: 'object-detection', enabled: true },
      ]),
    ).toBe('uncovered-region')
  })

  it('is the shipped rule for a tree with no detector at all', () => {
    expect(readRecoveryRecipeForSteps([])).toBe('uncovered-region')
  })
})

describe('planMotionCropRegions — the measured region rule', () => {
  it('pads a motion box about its centre and keeps it when nothing else overlaps', () => {
    const [region] = planMotionCropRegions({
      regions: [{ x: 0.4, y: 0.4, w: 0.1, h: 0.1 }],
      detections: [],
      native: NATIVE,
    })
    // ×1.5 about the centre: same centre, 1.5× the extent.
    near(region?.w ?? 0, 0.1 * MOTION_CROP_MOTION_PAD)
    near(region?.h ?? 0, 0.1 * MOTION_CROP_MOTION_PAD)
    near((region?.x ?? 0) + (region?.w ?? 0) / 2, 0.45)
    near((region?.y ?? 0) + (region?.h ?? 0) / 2, 0.45)
  })

  it('does NOT skip a region a full-frame box already covers — a tracked box is a seed', () => {
    // The shipped rule drops this region (covered ≈ 100%). The measured one
    // keeps it: the full-frame box is what the crop is meant to look closer at.
    const regions = planMotionCropRegions({
      regions: [{ x: 0.4, y: 0.4, w: 0.05, h: 0.05 }],
      detections: [{ x: 0.39, y: 0.39, w: 0.08, h: 0.08 }],
      native: NATIVE,
    })
    expect(regions.length).toBeGreaterThan(0)
  })

  it('unions an intersecting tracked box, padded ×1.25, into the motion region', () => {
    const motion = { x: 0.4, y: 0.4, w: 0.04, h: 0.04 }
    const tracked = { x: 0.42, y: 0.42, w: 0.04, h: 0.04 }
    const [region] = planMotionCropRegions({
      regions: [motion],
      detections: [tracked],
      native: NATIVE,
    })
    // The union spans the padded motion box's left edge and the padded
    // tracked box's right edge.
    const motionLeft = 0.42 - (0.04 * MOTION_CROP_MOTION_PAD) / 2
    const trackedRight = 0.44 + (0.04 * MOTION_CROP_TRACKED_PAD) / 2
    near(region?.x ?? 0, motionLeft)
    near((region?.x ?? 0) + (region?.w ?? 0), trackedRight)
  })

  it('ignores a tracked box that does not intersect any motion region', () => {
    const [region] = planMotionCropRegions({
      regions: [{ x: 0.1, y: 0.1, w: 0.05, h: 0.05 }],
      detections: [{ x: 0.8, y: 0.8, w: 0.1, h: 0.1 }],
      native: NATIVE,
    })
    near(region?.w ?? 0, 0.05 * MOTION_CROP_MOTION_PAD)
  })

  it('merges two overlapping padded motion regions into one', () => {
    const regions = planMotionCropRegions({
      regions: [
        { x: 0.4, y: 0.4, w: 0.04, h: 0.04 },
        { x: 0.43, y: 0.4, w: 0.04, h: 0.04 },
      ],
      detections: [],
      native: NATIVE,
    })
    expect(regions).toHaveLength(1)
  })

  it('swallows a small region sitting inside a large one', () => {
    const regions = planMotionCropRegions({
      regions: [
        { x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
        { x: 0.2, y: 0.2, w: 0.02, h: 0.02 },
      ],
      detections: [],
      native: NATIVE,
    })
    expect(regions).toHaveLength(1)
  })

  it('keeps two regions far enough apart that their padded boxes do not touch', () => {
    const regions = planMotionCropRegions({
      regions: [
        { x: 0.05, y: 0.05, w: 0.02, h: 0.02 },
        { x: 0.8, y: 0.8, w: 0.02, h: 0.02 },
      ],
      detections: [],
      native: NATIVE,
    })
    expect(regions).toHaveLength(2)
  })

  it('clamps a padded region to the frame', () => {
    const [region] = planMotionCropRegions({
      regions: [{ x: 0, y: 0, w: 0.1, h: 0.1 }],
      detections: [],
      native: NATIVE,
    })
    expect(region?.x).toBeGreaterThanOrEqual(0)
    expect(region?.y).toBeGreaterThanOrEqual(0)
    expect((region?.x ?? 0) + (region?.w ?? 0)).toBeLessThanOrEqual(1)
  })

  it('caps the regions per frame, largest area first', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      x: i * 0.09,
      y: 0.5,
      w: 0.01 + i * 0.002,
      h: 0.01,
    }))
    const regions = planMotionCropRegions({ regions: many, detections: [], native: NATIVE })
    expect(regions.length).toBeLessThanOrEqual(MOTION_CROP_MAX_REGIONS)
    // Largest first: the widest input region survives the cap.
    expect(regions[0]?.w).toBeGreaterThan(regions[1]?.w ?? 0)
  })

  it('yields nothing when motion is silent — the full-frame pass is the only arm left', () => {
    expect(planMotionCropRegions({ regions: [], detections: [], native: NATIVE })).toEqual([])
  })
})

describe('planMotionCrops — geometry of the measured recipe', () => {
  it('never produces a crop smaller than the measured magnification floor', () => {
    const crops = planMotionCrops({
      regions: [{ x: 0.5, y: 0.5, w: 0.005, h: 0.005 }],
      detections: [],
      native: NATIVE,
    })
    expect(crops.length).toBeGreaterThan(0)
    for (const crop of crops) expect(crop.side).toBeGreaterThanOrEqual(RECOVERY_CROP_MIN_SIDE_PX)
  })

  it('keeps every crop inside the frame', () => {
    const crops = planMotionCrops({
      regions: [{ x: 0.97, y: 0.95, w: 0.03, h: 0.05 }],
      detections: [],
      native: NATIVE,
    })
    for (const crop of crops) {
      expect(crop.left).toBeGreaterThanOrEqual(0)
      expect(crop.top).toBeGreaterThanOrEqual(0)
      expect(crop.left + crop.side).toBeLessThanOrEqual(NATIVE.width)
      expect(crop.top + crop.side).toBeLessThanOrEqual(NATIVE.height)
    }
  })

  it('dedupes the CROPS by containment — two separate corner regions collapse to one square', () => {
    // Both regions are small enough to take the magnification floor and close
    // enough to the corner that clamping slides both squares to (0,0). They do
    // not merge as REGIONS (their padded boxes never touch), so the dedupe is
    // the only thing that stops the detector seeing the same pixels twice.
    // Containment is the only dedupe: a square that merely OVERLAPS another
    // still runs, because the pixels it adds are pixels no other crop shows.
    const crops = planMotionCrops({
      regions: [
        { x: 0.001, y: 0.001, w: 0.002, h: 0.002 },
        { x: 0.02, y: 0.001, w: 0.002, h: 0.002 },
      ],
      detections: [],
      native: NATIVE,
    })
    expect(crops).toHaveLength(1)
    expect(crops[0]).toEqual({ left: 0, top: 0, side: RECOVERY_CROP_MIN_SIDE_PX })
  })

  it('keeps two squares that overlap without containing each other', () => {
    const crops = planMotionCrops({
      regions: [
        { x: 0.3, y: 0.5, w: 0.004, h: 0.004 },
        { x: 0.4, y: 0.5, w: 0.004, h: 0.004 },
      ],
      detections: [],
      native: NATIVE,
    })
    expect(crops).toHaveLength(2)
  })

  it('yields nothing on a frame too small to magnify', () => {
    expect(
      planMotionCrops({
        regions: [{ x: 0.4, y: 0.4, w: 0.1, h: 0.1 }],
        detections: [],
        native: { width: 320, height: 240 },
      }),
    ).toEqual([])
  })
})

describe('applyCropClassFloors — the two false positives the crop arm produced', () => {
  it('drops the measured night-IR vehicle at 0.749 and person at 0.701', () => {
    const verdict = applyCropClassFloors([det('v', 'vehicle', 0.749), det('p', 'person', 0.701)])
    expect(verdict.kept).toEqual([])
    expect(verdict.dropped).toEqual([
      { macroClass: 'vehicle', score: 0.749, floor: CROP_CLASS_FLOORS.vehicle },
      { macroClass: 'person', score: 0.701, floor: CROP_CLASS_FLOORS.person },
    ])
  })

  it('does NOT gate animal — zero false animals were produced at any gate', () => {
    const verdict = applyCropClassFloors([det('a', 'animal', 0.52)])
    expect(verdict.kept.map((d) => d.id)).toEqual(['a'])
    expect(verdict.dropped).toEqual([])
  })

  it('keeps a confident person or vehicle from a crop', () => {
    const verdict = applyCropClassFloors([det('v', 'vehicle', 0.95), det('p', 'person', 0.9)])
    expect(verdict.kept.map((d) => d.id)).toEqual(['v', 'p'])
  })

  it('keeps a class it has no floor for rather than dropping what it cannot judge', () => {
    const verdict = applyCropClassFloors([det('u', 'package', 0.1)])
    expect(verdict.kept.map((d) => d.id)).toEqual(['u'])
  })

  it('reports every drop, so a branch that removes work is never silent', () => {
    const verdict = applyCropClassFloors([det('v', 'vehicle', 0.1), det('a', 'animal', 0.1)])
    expect(verdict.dropped).toHaveLength(1)
    expect(verdict.dropped[0]?.macroClass).toBe('vehicle')
  })
})
