/**
 * Zone MEMBERSHIP threshold — the operator's "how far inside counts?".
 *
 * Membership is what gets stamped onto an event as `zones`, and a
 * notification rule's `zones` condition is a plain set-membership test over
 * that field. So membership — not the zone-RULE threshold — is what decides
 * whether a zone-scoped notification fires.
 *
 * Until 2026-07-31 membership was `overlap > 0`: a subject clipping a zone by
 * a single pixel counted as "in the zone", and the operator-facing
 * `bboxInclusionPct` had no effect on this path at all. Measured on the
 * 2026-07-30 incident: a dog whose bbox overlapped the `Aiuola` polygon by
 * 4.8% would have been stamped as inside it.
 *
 * The threshold is now injectable and DEFAULTS TO THE OLD VALUE, so nothing
 * changes until an operator sets one — a floor chosen without evidence is how
 * detections get lost quietly.
 */
import { describe, it, expect } from 'vitest'
import type { Zone } from '@camstack/types'
import { ZoneEngine } from '../zone-engine.js'

const FRAME_W = 640
const FRAME_H = 360

/** A zone covering the RIGHT HALF of the frame: x 0.5→1.0, full height. */
const rightHalf: Zone = {
  id: 'zone-right',
  name: 'Right half',
  kind: 'polygon',
  polygon: [
    { x: 0.5, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0.5, y: 1 },
  ],
  color: '#34c759',
}

/** Bbox in DETECTION-FRAME PIXELS, as the engine receives it (`w`/`h`, not
 *  `width`/`height` — the detector's shape is converted before this point). */
const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h })

describe('zone membership threshold', () => {
  const engine = new ZoneEngine()

  it('by DEFAULT stamps on any positive overlap — unchanged from before', () => {
    // 10% of this box lies right of x=0.5 (320px).
    const grazing = box(292, 100, 40, 40)
    const memberships = engine.annotateDetection(grazing, [rightHalf], FRAME_W, FRAME_H)
    expect(memberships.map((m) => m.zoneId)).toEqual(['zone-right'])
    expect(memberships[0]!.overlap).toBeGreaterThan(0)
    expect(memberships[0]!.overlap).toBeLessThan(0.5)
  })

  it('DROPS a grazing subject once a threshold is set', () => {
    const grazing = box(292, 100, 40, 40) // ~30% inside
    expect(
      engine.annotateDetection(
        grazing,
        [rightHalf],
        FRAME_W,
        FRAME_H,
        undefined,
        undefined,
        undefined,
        0.5,
      ),
    ).toEqual([])
  })

  it('KEEPS a subject that is genuinely inside, at the same threshold', () => {
    const inside = box(400, 100, 40, 40) // wholly right of x=320
    const memberships = engine.annotateDetection(
      inside,
      [rightHalf],
      FRAME_W,
      FRAME_H,
      undefined,
      undefined,
      undefined,
      0.5,
    )
    expect(memberships.map((m) => m.zoneId)).toEqual(['zone-right'])
    expect(memberships[0]!.overlap).toBeCloseTo(1, 2)
  })

  it('reproduces the 2026-07-30 dog: a sliver of overlap passes today, fails at any real bar', () => {
    // Overlap is measured by SAMPLING an 8×8 grid over the bbox, so the
    // fraction is quantised to 1/64 and the smallest non-zero value a
    // 40px-wide box can report is one column = 12.5%. That is already well
    // below any meaningful "inside the zone", which is the point: the live
    // dog measured 4.8%, finer than this engine can even resolve.
    const grazeBox = box(285, 100, 40, 40) // only the rightmost column clears x=320
    const grazed = engine.annotateDetection(grazeBox, [rightHalf], FRAME_W, FRAME_H)
    expect(grazed).toHaveLength(1)
    expect(grazed[0]!.overlap).toBeLessThanOrEqual(0.125)

    expect(
      engine.annotateDetection(
        grazeBox,
        [rightHalf],
        FRAME_W,
        FRAME_H,
        undefined,
        undefined,
        undefined,
        0.25,
      ),
    ).toEqual([])
  })

  it('never stamps a zone the subject does not touch, threshold or not', () => {
    const outside = box(10, 10, 40, 40)
    expect(engine.annotateDetection(outside, [rightHalf], FRAME_W, FRAME_H)).toEqual([])
    expect(
      engine.annotateDetection(
        outside,
        [rightHalf],
        FRAME_W,
        FRAME_H,
        undefined,
        undefined,
        undefined,
        0,
      ),
    ).toEqual([])
  })
})
