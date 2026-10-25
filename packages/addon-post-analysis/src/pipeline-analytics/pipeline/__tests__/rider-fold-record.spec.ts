/**
 * The D34 record gap — a folded rider must reach the RECORD, not a RAM field.
 *
 * `pairRiders` itself has been right since 2026-07-31 and is covered by
 * `rider-pairing.spec.ts`. What was wrong is everything after it: the pair was
 * written to `lastRiderPairs`, a per-processor field behind an accessor with
 * ZERO callers, carrying scores instead of entities. D34 and the code comment
 * both claimed "both entities stay on the record"; nothing durable ever said
 * `rider` anywhere.
 *
 * Two things are pinned here, and they are the two halves of the fix:
 *
 *  1. the fold is RESOLVED to the surviving vehicle's track, so the addon has
 *     something to stamp — this is what a RAM field could never give;
 *  2. a fold whose vehicle the tracker did NOT emit still ships, WITHOUT a
 *     trackId, so the drop is reportable. A branch that drops work silently is
 *     how the original gap survived unnoticed.
 *
 * The neutralisation for (2) is the real cause: the vehicle is held below
 * `minHits`, which is exactly when a live fold lands nowhere.
 */

import type { FrameResult, ObjectDetection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { FrameProcessor } from '../frame-processor.js'

const FRAME = { width: 1280, height: 720 }

function detection(
  id: string,
  macroClass: string,
  originalClass: string,
  score: number,
  bbox: { x: number; y: number; width: number; height: number },
): ObjectDetection {
  return {
    id,
    kind: 'first-level',
    macroClass,
    score,
    labels: [],
    bbox,
    debug: { originalClass },
  }
}

/**
 * The MEASURED reference cyclist — device 102, track `9eaa0320`, 1280×720.
 * Person over bike, 58% overlap, person centre above the machine's.
 */
function cyclist(): readonly ObjectDetection[] {
  return [
    detection('p', 'person', 'person', 0.72, { x: 1122, y: 204, width: 70, height: 164 }),
    detection('v', 'vehicle', 'bicycle', 0.572, { x: 1112, y: 271, width: 79, height: 139 }),
  ]
}

function frame(detections: readonly ObjectDetection[], timestamp: number): FrameResult {
  return {
    kind: 'frame',
    frameId: `f-${timestamp}`,
    deviceId: 102,
    timestamp,
    width: FRAME.width,
    height: FRAME.height,
    detections,
  }
}

describe('rider fold — the record, not a RAM field', () => {
  it('names the SURVIVING vehicle track once the tracker confirms it', () => {
    const processor = new FrameProcessor(102, { minHits: 1 })
    const result = processor.process({ timestamp: 1_000, frame: frame(cyclist(), 1_000) })

    expect(result.riderFolds).toHaveLength(1)
    const fold = result.riderFolds[0]!
    expect(fold.vehicleClass).toBe('bicycle')
    // The whole point: an ENTITY the addon can stamp, not a pair of scores.
    expect(typeof fold.trackId).toBe('string')

    // …and it is the VEHICLE's track that survived, never the person's.
    const survivor = result.tracked.find((t) => t.trackId === fold.trackId)
    expect(survivor?.className).toBe('vehicle')
    // The person half is gone from the frame — that is D34 working, unchanged.
    expect(result.tracked.map((t) => t.className)).toEqual(['vehicle'])
  })

  it('still reports the fold when no track survived it, so the drop is sayable', () => {
    // One frame at `minHits: 5`: the vehicle is folded and tracked internally,
    // but NOT emitted — the real shape of "the fold landed nowhere".
    const processor = new FrameProcessor(102, { minHits: 5 })
    const result = processor.process({ timestamp: 1_000, frame: frame(cyclist(), 1_000) })

    expect(result.tracked).toHaveLength(0)
    expect(result.riderFolds).toHaveLength(1)
    expect(result.riderFolds[0]?.trackId).toBeUndefined()
    // The scores still ride along — they are what an operator argues with.
    expect(result.riderFolds[0]?.vehicleClass).toBe('bicycle')
    expect(result.riderFolds[0]?.personScore).toBeCloseTo(0.72, 3)
  })

  /**
   * D407 — the surviving subject BOX must contain the rider.
   *
   * The fold's own comment says "a person ON a two-wheeler is ONE subject";
   * the box it emitted said otherwise. Every crop downstream — the best-shot
   * thumbnail, the central-square layout, the close-time keyFrame derive —
   * reads `TrackedDetectionOut.bbox`, so a machine-only box is a rider-less
   * keyframe by construction. Operator, device 102, tracks `7f50622b` and
   * `9cbc4791`.
   */
  it('emits the rider+machine UNION as the surviving track bbox', () => {
    const processor = new FrameProcessor(102, { minHits: 1 })
    const result = processor.process({ timestamp: 1_000, frame: frame(cyclist(), 1_000) })

    const survivor = result.tracked.find((t) => t.className === 'vehicle')
    expect(survivor).toBeDefined()
    const box = survivor!.bbox
    // person 1122,204,70x164 ∪ bike 1112,271,79x139
    expect(box).toMatchObject({ x: 1112, y: 204, w: 80, h: 206 })
  })

  it('carries the machine’s by-bbox side tables onto the widened box', () => {
    // Every frame-local fact this file keeps is keyed by the bbox OBJECT. A
    // widened box that did not inherit them would silently strip a folded
    // rider of its embedding and its source-detection id (and, in production,
    // of its vehicle-classifier label, its mask and its plate read).
    const machine: ObjectDetection = {
      ...detection('v', 'vehicle', 'motorcycle', 0.572, {
        x: 1112,
        y: 271,
        width: 79,
        height: 139,
      }),
      embedding: [0.1, 0.2, 0.3],
      embeddingModelId: 'clip-v1',
    }
    const rider = detection('p', 'person', 'person', 0.72, {
      x: 1122,
      y: 204,
      width: 70,
      height: 164,
    })

    const folded = new FrameProcessor(102, { minHits: 1 }).process({
      timestamp: 1_000,
      frame: frame([rider, machine], 1_000),
    })
    const survivor = folded.tracked.find((t) => t.className === 'vehicle')
    expect(survivor?.bbox).toMatchObject({ x: 1112, y: 204, w: 80, h: 206 })
    expect(survivor?.sourceDetectionId).toBe('v')
    expect(survivor?.embedding).toEqual([0.1, 0.2, 0.3])
    expect(survivor?.embeddingModelId).toBe('clip-v1')
    // …and the fold still names the machine it folded.
    expect(folded.riderFolds[0]?.vehicleClass).toBe('motorcycle')
  })

  it('reports nothing on a frame with no two-wheeler', () => {
    const processor = new FrameProcessor(102, { minHits: 1 })
    const result = processor.process({
      timestamp: 1_000,
      frame: frame(
        [
          detection('p', 'person', 'person', 0.9, { x: 10, y: 10, width: 50, height: 120 }),
          detection('v', 'vehicle', 'car', 0.8, { x: 20, y: 40, width: 200, height: 120 }),
        ],
        1_000,
      ),
    })
    expect(result.riderFolds).toEqual([])
    // Nothing was folded: a pedestrian beside a CAR is two subjects, always.
    expect(result.tracked).toHaveLength(2)
  })
})
