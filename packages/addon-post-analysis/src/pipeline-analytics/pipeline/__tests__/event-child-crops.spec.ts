/**
 * Tests for event-child-crops helpers: iou() and buildEventChildCrops().
 *
 * Scenario: a person detection (P1, big box) has a face detail and a plate
 * detail. An ObjectEvent is emitted with a bbox close to P1. A second event
 * has a bbox far away (no overlap). A third event has no bbox.
 */
import { describe, expect, it } from 'vitest'
import { defined } from '../../../__tests__/support/vitest-mock.js'
import type { ObjectDetection } from '@camstack/types'
import { iou, buildEventChildCrops, type PixelBox } from '../event-child-crops.js'

// ---------------------------------------------------------------------------
// iou() unit tests
// ---------------------------------------------------------------------------
describe('iou', () => {
  it('returns 1.0 for identical boxes', () => {
    const box: PixelBox = { x: 10, y: 10, w: 100, h: 200 }
    expect(iou(box, box)).toBeCloseTo(1.0)
  })

  it('returns 0 for non-overlapping boxes', () => {
    const a: PixelBox = { x: 0, y: 0, w: 50, h: 50 }
    const b: PixelBox = { x: 100, y: 100, w: 50, h: 50 }
    expect(iou(a, b)).toBe(0)
  })

  it('returns correct value for partial overlap', () => {
    // a: [0,0 → 100,100]  b: [50,50 → 150,150]
    // intersection: [50,50 → 100,100] = 50*50 = 2500
    // union: 100*100 + 100*100 - 2500 = 17500
    const a: PixelBox = { x: 0, y: 0, w: 100, h: 100 }
    const b: PixelBox = { x: 50, y: 50, w: 100, h: 100 }
    expect(iou(a, b)).toBeCloseTo(2500 / 17500, 5)
  })

  it('returns 0 for touching boxes (shared edge, no area)', () => {
    const a: PixelBox = { x: 0, y: 0, w: 50, h: 50 }
    const b: PixelBox = { x: 50, y: 0, w: 50, h: 50 }
    expect(iou(a, b)).toBe(0)
  })

  it('returns 0 when one box has zero area', () => {
    const a: PixelBox = { x: 10, y: 10, w: 0, h: 50 }
    const b: PixelBox = { x: 10, y: 10, w: 50, h: 50 }
    expect(iou(a, b)).toBe(0)
  })

  it('handles a small box fully inside a large box', () => {
    // inner: [10,10 → 30,30] = 400 area
    // outer: [0,0 → 100,100] = 10000 area
    // intersection = 400, union = 10000 + 400 - 400 = 10000
    const outer: PixelBox = { x: 0, y: 0, w: 100, h: 100 }
    const inner: PixelBox = { x: 10, y: 10, w: 20, h: 20 }
    expect(iou(outer, inner)).toBeCloseTo(400 / 10000, 5)
  })
})

// ---------------------------------------------------------------------------
// buildEventChildCrops() — helper builders
// ---------------------------------------------------------------------------

function makeFirstLevel(id: string, bbox: PixelBox): ObjectDetection {
  return {
    id,
    kind: 'first-level',
    macroClass: 'person',
    score: 0.95,
    labels: [],
    bbox: { x: bbox.x, y: bbox.y, width: bbox.w, height: bbox.h },
  }
}

function makeDetail(
  id: string,
  parentId: string,
  macro: 'face' | 'plate',
  bbox: PixelBox,
): ObjectDetection {
  return {
    id,
    kind: 'detail',
    macroClass: macro,
    score: 0.9,
    labels: [],
    parentId,
    bbox: { x: bbox.x, y: bbox.y, width: bbox.w, height: bbox.h },
  }
}

// ---------------------------------------------------------------------------
// buildEventChildCrops() tests
// ---------------------------------------------------------------------------
const E1 = 1
const E2 = 2
const E_FAR = 3
const E_NO_BBOX = 4
const E_WITH_BBOX = 5

describe('buildEventChildCrops', () => {
  // Shared geometry: P1 = large person box at top-left quadrant
  const P1_BOX: PixelBox = { x: 100, y: 100, w: 200, h: 400 }
  // Event bbox perturbed by a few pixels (simulates tracker smoothing)
  const EVENT_NEAR_P1: PixelBox = { x: 103, y: 97, w: 198, h: 403 }
  // Event bbox far away — no overlap
  const EVENT_FAR: PixelBox = { x: 900, y: 900, w: 80, h: 80 }

  // Face and plate crops for P1
  const FACE_BOX: PixelBox = { x: 120, y: 110, w: 60, h: 70 }
  const PLATE_BOX: PixelBox = { x: 130, y: 420, w: 80, h: 30 }

  it('maps a near event to face+plate childCrops when bboxes overlap', () => {
    const detections: ObjectDetection[] = [
      makeFirstLevel('P1', P1_BOX),
      makeDetail('D_face', 'P1', 'face', FACE_BOX),
      makeDetail('D_plate', 'P1', 'plate', PLATE_BOX),
    ]
    const events = [{ id: E1, bbox: EVENT_NEAR_P1 }]

    const result = buildEventChildCrops(events, detections)

    expect(result.size).toBe(1)
    const crops = result.get(E1)
    expect(crops).toBeDefined()
    expect(crops).toHaveLength(2)
    const kinds = crops!.map((c) => c.kind).toSorted()
    expect(kinds).toEqual(['faceCrop', 'plateCrop'])

    // Verify the face crop bbox was correctly mapped from width/height to w/h
    const face = crops!.find((c) => c.kind === 'faceCrop')!
    expect(face.bbox).toEqual({ x: FACE_BOX.x, y: FACE_BOX.y, w: FACE_BOX.w, h: FACE_BOX.h })

    const plate = crops!.find((c) => c.kind === 'plateCrop')!
    expect(plate.bbox).toEqual({ x: PLATE_BOX.x, y: PLATE_BOX.y, w: PLATE_BOX.w, h: PLATE_BOX.h })
  })

  it('returns no childCrops for a far-away event with no overlap', () => {
    const detections: ObjectDetection[] = [
      makeFirstLevel('P1', P1_BOX),
      makeDetail('D_face', 'P1', 'face', FACE_BOX),
    ]
    const events = [{ id: E_FAR, bbox: EVENT_FAR }]

    const result = buildEventChildCrops(events, detections)
    expect(result.size).toBe(0)
  })

  it("routes each event to only its overlapping detection's children", () => {
    // Two distinct first-level detections: P1 (top-left) and P2 (bottom-right)
    const P2_BOX: PixelBox = { x: 600, y: 600, w: 150, h: 300 }
    const P2_FACE_BOX: PixelBox = { x: 620, y: 610, w: 50, h: 60 }
    // Event bbox overlapping P2 only
    const EVENT_NEAR_P2: PixelBox = { x: 602, y: 598, w: 148, h: 302 }

    const detections: ObjectDetection[] = [
      makeFirstLevel('P1', P1_BOX),
      makeDetail('D_face_p1', 'P1', 'face', FACE_BOX),
      makeFirstLevel('P2', P2_BOX),
      makeDetail('D_face_p2', 'P2', 'face', P2_FACE_BOX),
    ]
    const events = [
      { id: E1, bbox: EVENT_NEAR_P1 },
      { id: E2, bbox: EVENT_NEAR_P2 },
    ]

    const result = buildEventChildCrops(events, detections)

    expect(result.size).toBe(2)
    const crops1 = result.get(E1)
    expect(crops1).toHaveLength(1)
    expect(crops1![0]!.kind).toBe('faceCrop')
    expect(crops1![0]!.bbox).toEqual(FACE_BOX)

    const crops2 = result.get(E2)
    expect(crops2).toHaveLength(1)
    expect(crops2![0]!.kind).toBe('faceCrop')
    expect(crops2![0]!.bbox).toEqual(P2_FACE_BOX)
  })

  it('skips events with no bbox', () => {
    const detections: ObjectDetection[] = [
      makeFirstLevel('P1', P1_BOX),
      makeDetail('D_face', 'P1', 'face', FACE_BOX),
    ]
    // Mix: one event with bbox, one without
    const events = [{ id: E_NO_BBOX }, { id: E_WITH_BBOX, bbox: EVENT_NEAR_P1 }]

    const result = buildEventChildCrops(events, detections)

    expect(result.has(E_NO_BBOX)).toBe(false)
    expect(result.has(E_WITH_BBOX)).toBe(true)
  })

  it('keeps only the first face crop per detection when multiple face details exist', () => {
    const FACE_BOX_2: PixelBox = { x: 150, y: 120, w: 55, h: 65 }
    const detections: ObjectDetection[] = [
      makeFirstLevel('P1', P1_BOX),
      makeDetail('D_face_1', 'P1', 'face', FACE_BOX),
      makeDetail('D_face_2', 'P1', 'face', FACE_BOX_2), // second face crop — should be ignored
    ]
    const events = [{ id: E1, bbox: EVENT_NEAR_P1 }]

    const result = buildEventChildCrops(events, detections)

    const crops = result.get(E1)!
    const faceCrops = crops.filter((c) => c.kind === 'faceCrop')
    expect(faceCrops).toHaveLength(1)
    // First one wins
    expect(defined(faceCrops[0], 'faceCrops[0]').bbox).toEqual(FACE_BOX)
  })

  it('returns empty map when detections list is empty', () => {
    const events = [{ id: E1, bbox: P1_BOX }]
    const result = buildEventChildCrops(events, [])
    expect(result.size).toBe(0)
  })

  it('returns empty map when events list is empty', () => {
    const detections: ObjectDetection[] = [
      makeFirstLevel('P1', P1_BOX),
      makeDetail('D_face', 'P1', 'face', FACE_BOX),
    ]
    const result = buildEventChildCrops([], detections)
    expect(result.size).toBe(0)
  })

  it('does not attach childCrops when first-level has no detail children', () => {
    const detections: ObjectDetection[] = [
      makeFirstLevel('P1', P1_BOX),
      // No detail detections
    ]
    const events = [{ id: E1, bbox: EVENT_NEAR_P1 }]

    const result = buildEventChildCrops(events, detections)
    // P1 matched by IoU but has no crops → not in result
    expect(result.size).toBe(0)
  })
})
