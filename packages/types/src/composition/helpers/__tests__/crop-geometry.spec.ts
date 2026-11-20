/**
 * Crop camera (#611): the seed, the ratio lock, and the spec's place in the
 * engine-hosted helper family.
 */
import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../../device/device-type.js'
import { CompositionSchema } from '../../composition.js'
import { compileHelper } from '../compile.js'
import {
  CROP_MIN_SIDE,
  cropAspectRatio,
  cropCanvasAspect,
  moveCropRect,
  resizeCropRect,
  seedCropRect,
} from '../crop-geometry.js'
import {
  type CropHelperSpec,
  HelperSpecSchema,
  helperDeviceRefs,
  helperMembers,
  isEngineHostedHelper,
  newCropHelperSpec,
} from '../spec.js'

const FOUR_THREE = 4 / 3
const SIXTEEN_NINE = 16 / 9

describe('seedCropRect', () => {
  it('seeds a centred 16:9 crop of a 4:3 source whose pixels are 16:9', () => {
    const rect = seedCropRect('16:9', FOUR_THREE)
    expect(cropCanvasAspect(rect, FOUR_THREE)).toBeCloseTo(SIXTEEN_NINE, 6)
    expect(rect.x + rect.width / 2).toBeCloseTo(0.5, 6)
    expect(rect.y + rect.height / 2).toBeCloseTo(0.5, 6)
    // Wider than tall on a 4:3 source: the width is the leading side.
    expect(rect.width).toBeCloseTo(0.6, 6)
    expect(rect.height).toBeCloseTo(0.45, 6)
  })

  it('seeds a 1:1 crop of a wide source narrower than the frame, still inside it', () => {
    const rect = seedCropRect('1:1', SIXTEEN_NINE)
    expect(cropCanvasAspect(rect, SIXTEEN_NINE)).toBeCloseTo(1, 6)
    expect(rect.height).toBeCloseTo(0.6, 6)
    expect(rect.width).toBeLessThan(rect.height)
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.width).toBeLessThanOrEqual(1)
  })

  it('seeds a free crop as the middle quarter, whatever the source', () => {
    expect(seedCropRect('free', FOUR_THREE)).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 })
    expect(cropAspectRatio('free')).toBeNull()
  })
})

describe('resizeCropRect', () => {
  const start = seedCropRect('16:9', FOUR_THREE)

  it('keeps the preset ratio while a corner is dragged, anchoring the opposite corner', () => {
    const out = resizeCropRect({
      rect: start,
      handle: 'se',
      point: { x: 0.95, y: 0.6 },
      aspect: '16:9',
      sourceAspect: FOUR_THREE,
    })
    expect(cropCanvasAspect(out, FOUR_THREE)).toBeCloseTo(SIXTEEN_NINE, 6)
    expect(out.x).toBeCloseTo(start.x, 6)
    expect(out.y).toBeCloseTo(start.y, 6)
    expect(out.width).toBeGreaterThan(start.width)
  })

  it('holds the ratio from a north-west drag and anchors the south-east corner', () => {
    const out = resizeCropRect({
      rect: start,
      handle: 'nw',
      point: { x: 0.1, y: 0.2 },
      aspect: '4:3',
      sourceAspect: FOUR_THREE,
    })
    expect(cropCanvasAspect(out, FOUR_THREE)).toBeCloseTo(FOUR_THREE, 6)
    expect(out.x + out.width).toBeCloseTo(start.x + start.width, 6)
    expect(out.y + out.height).toBeCloseTo(start.y + start.height, 6)
  })

  it('never leaves the source and never collapses below the minimum', () => {
    const out = resizeCropRect({
      rect: start,
      handle: 'se',
      point: { x: 5, y: 5 },
      aspect: '16:9',
      sourceAspect: FOUR_THREE,
    })
    expect(out.x + out.width).toBeLessThanOrEqual(1 + 1e-9)
    expect(out.y + out.height).toBeLessThanOrEqual(1 + 1e-9)
    expect(cropCanvasAspect(out, FOUR_THREE)).toBeCloseTo(SIXTEEN_NINE, 6)

    const tiny = resizeCropRect({
      rect: start,
      handle: 'se',
      point: { x: start.x, y: start.y },
      aspect: 'free',
      sourceAspect: FOUR_THREE,
    })
    expect(tiny.width).toBeCloseTo(CROP_MIN_SIDE, 6)
    expect(tiny.height).toBeCloseTo(CROP_MIN_SIDE, 6)
  })

  it('free follows the pointer on both axes independently', () => {
    const out = resizeCropRect({
      rect: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 },
      handle: 'se',
      point: { x: 0.9, y: 0.4 },
      aspect: 'free',
      sourceAspect: FOUR_THREE,
    })
    expect(out.width).toBeCloseTo(0.7, 6)
    expect(out.height).toBeCloseTo(0.2, 6)
  })
})

describe('moveCropRect', () => {
  it('moves without resizing and stops at the source edge', () => {
    const rect = { x: 0.5, y: 0.5, width: 0.4, height: 0.3 }
    expect(moveCropRect(rect, 0.5, -2)).toEqual({ x: 0.6, y: 0, width: 0.4, height: 0.3 })
  })
})

describe('crop helper spec', () => {
  const source = { addonId: 'provider-rtsp', stableId: 'cam-a' }
  const crop: CropHelperSpec = newCropHelperSpec(source, seedCropRect('16:9', FOUR_THREE))

  it('defaults to 16:9, 10 fps, mid and low, and round-trips the helper union', () => {
    expect(crop.aspect).toBe('16:9')
    expect(crop.fps).toBe(10)
    expect(crop.publishedProfiles).toEqual(['mid', 'low'])
    expect(HelperSpecSchema.parse(crop)).toEqual(crop)
  })

  it('refuses a rectangle outside the unit square and an unknown preset', () => {
    expect(
      HelperSpecSchema.safeParse({ ...crop, rect: { x: 0.5, y: 0, width: 0.5, height: 1.5 } })
        .success,
    ).toBe(false)
    expect(HelperSpecSchema.safeParse({ ...crop, aspect: '21:9' }).success).toBe(false)
  })

  it('is engine-hosted, reads no member, names its source, and compiles to a new Camera', () => {
    expect(isEngineHostedHelper(crop)).toBe(true)
    expect(helperMembers(crop)).toEqual([])
    expect(helperDeviceRefs(crop)).toEqual([source])
    const compiled = compileHelper(crop)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.composition.target).toEqual({ kind: 'new', type: DeviceType.Camera })
    expect(compiled.composition.features).toEqual([])
    expect(CompositionSchema.parse(compiled.composition).helper).toEqual(crop)
  })
})
