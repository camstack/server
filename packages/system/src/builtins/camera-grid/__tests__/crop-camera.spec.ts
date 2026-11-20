/**
 * Crop camera (#611): a crop is a ONE-cell grid on the grid engine. The cell
 * covers the whole canvas, its source rectangle is the crop. Everything else a
 * grid does (profiles 1:1, derived canvas, no upscale, detection mapping) is
 * inherited, so these specs pin the compile step and prove the inherited
 * behaviour holds for a single cell.
 */
import { type CropHelperSpec, newCropHelperSpec, seedCropRect } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  CROP_FULL_CELL,
  gridBlockSourceRefs,
  gridComposition,
  resolveGridCells,
  sourceRefKey,
} from '../grid-blocks.js'
import { mapDetectionToCanvas } from '../grid-detection-mapping.js'
import { gridProfilePlans } from '../grid-profiles.js'
import type { ServedProfile } from '../grid-profiles.js'

const SOURCE = { addonId: 'provider-rtsp', stableId: 'cam-a' }
const SOURCE_DEVICE = 611

/** A 4:3 source cropped to 16:9, as the editor seeds it. */
const CROP: CropHelperSpec = newCropHelperSpec(SOURCE, seedCropRect('16:9', 4 / 3))
const resolve = (ref: { addonId: string; stableId: string }): number | null =>
  sourceRefKey(ref) === sourceRefKey(SOURCE) ? SOURCE_DEVICE : null

describe('a crop compiles to a one-cell layout', () => {
  it('has one cell covering the whole canvas whose source rect is the crop', () => {
    const { cells, unresolved } = resolveGridCells(CROP, resolve)
    expect(unresolved).toEqual([])
    expect(cells).toEqual([{ deviceId: SOURCE_DEVICE, source: CROP.rect, cell: CROP_FULL_CELL }])
  })

  it('names the source it could not resolve and composes nothing', () => {
    const { cells, unresolved } = resolveGridCells(CROP, () => null)
    expect(cells).toEqual([])
    expect(unresolved).toEqual([SOURCE])
  })

  it('reads one source, and compiles to a new camera carrying the crop spec', () => {
    expect(gridBlockSourceRefs(CROP)).toEqual([SOURCE])
    expect(gridComposition(CROP).helper).toEqual(CROP)
  })
})

describe('detections through the single crop cell', () => {
  const sourceFrame = { width: 1600, height: 1200 }
  // A 16:9 crop of the 4:3 frame: 960x540 source pixels, at (320, 330).
  const { cells } = resolveGridCells(CROP, resolve)
  const canvas = { width: 960, height: 540 }
  const mapping = cells.map((c) => ({ source: c.source, cell: c.cell }))

  it('lands a box inside the crop at its position within the crop', () => {
    const boxes = mapDetectionToCanvas({
      bbox: { x: 320 + 96, y: 330 + 54, width: 96, height: 54 },
      sourceFrame,
      canvas,
      cells: mapping,
    })
    expect(boxes).toHaveLength(1)
    expect(boxes[0]?.x).toBeCloseTo(96, 3)
    expect(boxes[0]?.y).toBeCloseTo(54, 3)
    expect(boxes[0]?.width).toBeCloseTo(96, 3)
  })

  it('drops a box outside the crop: a subject nobody can see is not drawn at the edge', () => {
    const boxes = mapDetectionToCanvas({
      bbox: { x: 10, y: 10, width: 100, height: 100 },
      sourceFrame,
      canvas,
      cells: mapping,
    })
    expect(boxes).toEqual([])
  })

  it('clips a box straddling the crop edge to what the crop shows', () => {
    const boxes = mapDetectionToCanvas({
      bbox: { x: 320 - 50, y: 330 + 100, width: 100, height: 100 },
      sourceFrame,
      canvas,
      cells: mapping,
    })
    expect(boxes).toHaveLength(1)
    expect(boxes[0]?.x).toBeCloseTo(0, 3)
    expect(boxes[0]?.width).toBeCloseTo(50, 3)
    expect(boxes[0]?.height).toBeCloseTo(100, 3)
  })
})

describe('profiles of a one-cell composition', () => {
  const served: readonly ServedProfile[] = [
    { profile: 'low', width: 640, height: 480 },
    { profile: 'mid', width: 1280, height: 960 },
    { profile: 'high', width: 3200, height: 2400 },
  ]
  const { cells } = resolveGridCells(CROP, resolve)
  const plans = gridProfilePlans({
    cells: cells.map((c) => ({ deviceId: c.deviceId, source: c.source, cell: c.cell })),
    publishedProfiles: ['mid', 'low'],
    profilesServedBy: () => served,
  })

  it('derives each canvas from the crop at THAT profile, so no profile is upscaled', () => {
    for (const entry of served) {
      const plan = plans.find((p) => p.profile === entry.profile)
      expect(plan?.offered).toBe(true)
      if (plan === undefined || !plan.offered) continue
      // The crop's pixels at this profile: its fraction of the source's size.
      const cropW = entry.width * CROP.rect.width
      expect(plan.canvas.width).toBeLessThanOrEqual(Math.ceil(cropW) + 1)
      expect(plan.canvas.width).toBeGreaterThanOrEqual(Math.floor(cropW) - 1)
      // The canvas follows the crop's aspect: 16:9, no letterbox.
      expect(plan.canvas.width / plan.canvas.height).toBeCloseTo(16 / 9, 1)
    }
  })

  it('offers all three profiles 1:1 and publishes only the chosen ones', () => {
    expect(plans.map((p) => [p.profile, p.offered])).toEqual([
      ['high', true],
      ['mid', true],
      ['low', true],
    ])
    const published = plans.filter((p) => p.offered && p.published).map((p) => p.profile)
    expect(published.sort()).toEqual(['low', 'mid'])
  })

  it('refuses a profile its only source does not serve, naming the source', () => {
    const noLow = gridProfilePlans({
      cells: cells.map((c) => ({ deviceId: c.deviceId, source: c.source, cell: c.cell })),
      publishedProfiles: ['mid', 'low'],
      profilesServedBy: () => served.filter((s) => s.profile !== 'low'),
    })
    const low = noLow.find((p) => p.profile === 'low')
    expect(low).toEqual({ profile: 'low', offered: false, missingSources: [SOURCE_DEVICE] })
  })
})
