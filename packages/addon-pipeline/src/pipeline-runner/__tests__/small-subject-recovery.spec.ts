/**
 * Small-subject recovery — the pure half.
 *
 * A 4K frame reaches a 320 detector at 1/12 scale: a dog measured at
 * 89–277 px in the source is 7–38 px for the model and is never emitted (camera 101, six
 * instants, five with no `animal` at all). The second pass cuts a native-
 * resolution square around the MOVING regions the full-frame pass did not
 * account for, runs the same detector on it, and fuses the boxes back before
 * the tracker. These tests pin the trigger, the geometry and the fusion.
 */

import type { ObjectDetection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  countRecoverySkips,
  fuseRecoveredDetections,
  MotionRegionMirror,
  planRecoveryCrops,
  RECOVERY_CROP_MAX_SIDE_PX,
  RECOVERY_CROP_MIN_SIDE_PX,
  RECOVERY_MAX_CROPS_PER_FRAME,
  RECOVERY_MOTION_MAX_AGE_MS,
  remapCropDetections,
  selectRecoveryStep,
} from '../small-subject-recovery.js'

const NATIVE = { width: 3840, height: 2160 }

function det(
  id: string,
  macroClass: string,
  bbox: { x: number; y: number; width: number; height: number },
  score = 0.9,
): ObjectDetection {
  return { id, kind: 'first-level', macroClass, score, labels: [], bbox }
}

describe('planRecoveryCrops — when the second pass runs', () => {
  it('runs on a small moving region the full-frame pass left uncovered (no detections at all)', () => {
    const crops = planRecoveryCrops({
      regions: [{ x: 0.66, y: 0.27, w: 0.09, h: 0.1 }],
      detections: [],
      native: NATIVE,
    })
    expect(crops).toHaveLength(1)
    const crop = crops[0]!
    expect(crop.side).toBeGreaterThanOrEqual(RECOVERY_CROP_MIN_SIDE_PX)
    expect(crop.side).toBeLessThanOrEqual(RECOVERY_CROP_MAX_SIDE_PX)
    // The region is inside the crop and the crop is inside the frame.
    expect(crop.left).toBeLessThanOrEqual(0.66 * NATIVE.width)
    expect(crop.left + crop.side).toBeGreaterThanOrEqual(0.75 * NATIVE.width)
    expect(crop.top).toBeGreaterThanOrEqual(0)
    expect(crop.top + crop.side).toBeLessThanOrEqual(NATIVE.height)
  })

  it('does NOT run when the full-frame detections already cover the motion', () => {
    // A person box covering the whole moving blob: nothing to recover.
    const crops = planRecoveryCrops({
      regions: [{ x: 0.6, y: 0.1, w: 0.1, h: 0.3 }],
      detections: [{ x: 0.58, y: 0.08, w: 0.14, h: 0.34 }],
      native: NATIVE,
    })
    expect(crops).toEqual([])
  })

  it('runs when a detected person leaves a meaningful part of the blob uncovered (the dog beside)', () => {
    // Person + dog merged into one blob 0.19 wide; the person box covers the
    // left 55% of it.
    const crops = planRecoveryCrops({
      regions: [{ x: 0.59, y: 0.04, w: 0.19, h: 0.35 }],
      detections: [{ x: 0.59, y: 0.04, w: 0.105, h: 0.35 }],
      native: NATIVE,
    })
    expect(crops).toHaveLength(1)
  })

  it('ignores a region too large to be a small subject (a whole-frame lighting change)', () => {
    const crops = planRecoveryCrops({
      regions: [{ x: 0.05, y: 0.05, w: 0.8, h: 0.8 }],
      detections: [],
      native: NATIVE,
    })
    expect(crops).toEqual([])
  })

  it('never plans more than the per-frame budget, largest uncovered region first', () => {
    const regions = [0.1, 0.3, 0.5, 0.7].map((x, i) => ({
      x,
      y: 0.5,
      w: 0.02 + i * 0.02,
      h: 0.05,
    }))
    const crops = planRecoveryCrops({ regions, detections: [], native: NATIVE })
    expect(crops).toHaveLength(RECOVERY_MAX_CROPS_PER_FRAME)
    // The two LARGEST regions (x = 0.7 and 0.5) won the budget.
    const centres = crops.map((c) => (c.left + c.side / 2) / NATIVE.width)
    expect(centres.some((c) => Math.abs(c - (0.7 + 0.04)) < 0.05)).toBe(true)
    expect(centres.some((c) => Math.abs(c - (0.5 + 0.03)) < 0.05)).toBe(true)
  })

  it('merges regions whose crops would overlap into one crop', () => {
    const crops = planRecoveryCrops({
      regions: [
        { x: 0.5, y: 0.5, w: 0.03, h: 0.03 },
        { x: 0.52, y: 0.52, w: 0.03, h: 0.03 },
      ],
      detections: [],
      native: NATIVE,
    })
    expect(crops).toHaveLength(1)
  })

  it('caps the square at the max side even for a wide region, so the model still magnifies', () => {
    const crops = planRecoveryCrops({
      regions: [{ x: 0.3, y: 0.3, w: 0.3, h: 0.1 }],
      detections: [],
      native: NATIVE,
    })
    expect(crops.length).toBeGreaterThan(0)
    for (const crop of crops) expect(crop.side).toBeLessThanOrEqual(RECOVERY_CROP_MAX_SIDE_PX)
  })

  it('on a frame smaller than the floor, the crop is the largest square that fits', () => {
    const crops = planRecoveryCrops({
      regions: [{ x: 0.4, y: 0.4, w: 0.05, h: 0.05 }],
      detections: [],
      native: { width: 640, height: 360 },
    })
    expect(crops).toEqual([])
  })
})

describe('remapCropDetections — crop view → frame space', () => {
  it('scales by the crop/view ratio and offsets by the crop origin', () => {
    const [mapped] = remapCropDetections(
      [det('r1', 'animal', { x: 100, y: 50, width: 200, height: 100 })],
      { left: 2400, top: 400, side: 800 },
      { width: 640, height: 640 },
      { width: 3840, height: 2160 },
      NATIVE,
    )
    expect(mapped?.bbox).toEqual({ x: 2525, y: 462.5, width: 250, height: 125 })
    expect(mapped?.macroClass).toBe('animal')
  })

  it('maps into a result space that differs from the native one (inline ≤640 frames)', () => {
    const [mapped] = remapCropDetections(
      [det('r1', 'animal', { x: 320, y: 320, width: 160, height: 160 })],
      { left: 0, top: 0, side: 640 },
      { width: 640, height: 640 },
      { width: 384, height: 216 },
      NATIVE,
    )
    expect(mapped?.bbox).toEqual({ x: 32, y: 32, width: 16, height: 16 })
  })

  it('drops a box clipped by the crop edge — a half subject is not a subject', () => {
    const mapped = remapCropDetections(
      [
        det('edge', 'person', { x: 0, y: 100, width: 300, height: 400 }),
        det('inner', 'animal', { x: 100, y: 100, width: 200, height: 100 }),
      ],
      { left: 2400, top: 400, side: 800 },
      { width: 640, height: 640 },
      NATIVE,
      NATIVE,
    )
    expect(mapped.map((d) => d.id)).toEqual(['inner'])
  })
})

describe('fuseRecoveredDetections — NMS against the full-frame pass', () => {
  const person = det('p', 'person', { x: 2266, y: 86, width: 400, height: 756 })

  it('keeps every full-frame box and adds a recovered box of another class', () => {
    const dog = det('d', 'animal', { x: 2550, y: 585, width: 330, height: 210 }, 0.82)
    const fused = fuseRecoveredDetections([person], [dog])
    expect(fused.map((d) => d.macroClass)).toEqual(['person', 'animal'])
    expect(fused[0]).toBe(person)
    expect(fused[1]?.bbox).toEqual(dog.bbox)
  })

  it('suppresses a recovered box that duplicates a full-frame box of the same class', () => {
    const again = det('p2', 'person', { x: 2270, y: 90, width: 396, height: 750 }, 0.7)
    expect(fuseRecoveredDetections([person], [again]).map((d) => d.id)).toEqual(['p'])
  })

  it('suppresses a recovered same-class box mostly contained in a full-frame box (a partial person)', () => {
    const torso = det('t', 'person', { x: 2300, y: 100, width: 300, height: 300 }, 0.6)
    expect(fuseRecoveredDetections([person], [torso]).map((d) => d.id)).toEqual(['p'])
  })

  it('keeps a recovered box of the same class elsewhere in the frame', () => {
    const other = det('o', 'person', { x: 100, y: 100, width: 200, height: 400 }, 0.6)
    const fused = fuseRecoveredDetections([person], [other])
    expect(fused).toHaveLength(2)
    expect(fused[1]?.bbox).toEqual(other.bbox)
    expect(fused[1]?.id.startsWith('recovered-')).toBe(true)
  })

  it('gives every recovered box a fresh id that cannot collide with the first pass', () => {
    const dog = det('p', 'animal', { x: 2550, y: 585, width: 330, height: 210 }, 0.82)
    const fused = fuseRecoveredDetections([person], [dog])
    expect(new Set(fused.map((d) => d.id)).size).toBe(2)
  })
})

describe('MotionRegionMirror — the regions a frame is judged against', () => {
  it('serves regions while fresh and nothing once they are stale', () => {
    const mirror = new MotionRegionMirror()
    mirror.note(
      101,
      [{ bbox: { x: 10, y: 20, w: 30, h: 40 }, pixelCount: 1, intensity: 1 }],
      320,
      180,
      1_000,
    )
    expect(mirror.fresh(101, 1_500)).toEqual([
      { x: 10 / 320, y: 20 / 180, w: 30 / 320, h: 40 / 180 },
    ])
    expect(mirror.fresh(101, 1_000 + RECOVERY_MOTION_MAX_AGE_MS + 1)).toEqual([])
    expect(mirror.fresh(616, 1_500)).toEqual([])
  })

  it('an empty analyzer result clears the regions rather than keeping the last positive ones', () => {
    const mirror = new MotionRegionMirror()
    mirror.note(
      101,
      [{ bbox: { x: 10, y: 20, w: 30, h: 40 }, pixelCount: 1, intensity: 1 }],
      320,
      180,
      1_000,
    )
    mirror.note(101, [], 320, 180, 1_100)
    expect(mirror.fresh(101, 1_200)).toEqual([])
  })
})

describe('selectRecoveryStep — the detector the second pass runs', () => {
  it('is the enabled first-level object detector, childless, with the same model', () => {
    const step = selectRecoveryStep([
      { addonId: 'package-detection', enabled: true },
      {
        addonId: 'object-detection',
        modelId: 'yolov9m-320',
        enabled: true,
        children: [{ addonId: 'face-detection', enabled: true }],
      },
    ])
    expect(step).toEqual({ addonId: 'object-detection', modelId: 'yolov9m-320', enabled: true })
  })

  it('is null when the tree has no object detector', () => {
    expect(selectRecoveryStep([{ addonId: 'package-detection', enabled: true }])).toBeNull()
    expect(selectRecoveryStep([{ addonId: 'object-detection', enabled: false }])).toBeNull()
  })
})

describe('native-recovery evidence (D377) — the second pass says what it measured', () => {
  it('stamps the score and the geometry the model actually saw on every remapped box', () => {
    const [mapped] = remapCropDetections(
      [det('r1', 'animal', { x: 100, y: 50, width: 200, height: 100 }, 0.87)],
      { left: 2400, top: 400, side: 800 },
      { width: 640, height: 640 },
      { width: 3840, height: 2160 },
      NATIVE,
    )
    expect(mapped?.nativeRecovery).toEqual({ score: 0.87, cropSidePx: 800, viewPx: 640 })
  })

  it('keeps the evidence through the fuse, so a downstream gate can read it', () => {
    const recovered = remapCropDetections(
      [det('r1', 'animal', { x: 100, y: 50, width: 200, height: 100 }, 0.87)],
      { left: 2400, top: 400, side: 800 },
      { width: 640, height: 640 },
      { width: 3840, height: 2160 },
      NATIVE,
    )
    const fused = fuseRecoveredDetections(
      [det('f0', 'person', { x: 0, y: 0, width: 100, height: 200 })],
      recovered,
    )
    expect(fused).toHaveLength(2)
    expect(fused[1]?.nativeRecovery?.score).toBe(0.87)
    // A full-frame box is NOT evidence of a native measurement.
    expect(fused[0]?.nativeRecovery).toBeUndefined()
  })
})

/**
 * WHY THE PASS DID NOT RUN IS A NUMBER, NOT AN ARGUMENT (D378).
 *
 * "The second pass stops running when a person is in the frame beside the dog"
 * was a live hypothesis on camera 101 and could not be answered from the logs:
 * the pass report counts the passes that RAN. `countRecoverySkips` classifies
 * the regions a frame offered against the same two gates `planRecoveryCrops`
 * filters on, so the report can say what each gate cost.
 */
describe('countRecoverySkips — why a frame planned no crop', () => {
  it('counts a region larger than the frame-fraction gate', () => {
    const counts = countRecoverySkips({
      regions: [{ x: 0.1, y: 0.1, w: 0.6, h: 0.6 }],
      detections: [],
      native: NATIVE,
    })
    expect(counts).toEqual({ tooLarge: 1, covered: 0, eligible: 0 })
  })

  it('counts a region the full-frame detections already cover', () => {
    const counts = countRecoverySkips({
      regions: [{ x: 0.2, y: 0.2, w: 0.1, h: 0.1 }],
      detections: [{ x: 0.15, y: 0.15, w: 0.2, h: 0.2 }],
      native: NATIVE,
    })
    expect(counts).toEqual({ tooLarge: 0, covered: 1, eligible: 0 })
  })

  it('counts as eligible exactly the region planRecoveryCrops plans on', () => {
    const input = {
      regions: [{ x: 0.66, y: 0.27, w: 0.09, h: 0.1 }],
      detections: [],
      native: NATIVE,
    }
    expect(countRecoverySkips(input)).toEqual({ tooLarge: 0, covered: 0, eligible: 1 })
    expect(planRecoveryCrops(input).length).toBeGreaterThan(0)
  })
})
