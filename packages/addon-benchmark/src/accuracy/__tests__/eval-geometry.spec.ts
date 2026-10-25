import { describe, expect, it } from 'vitest'
import type { EvalBox } from '../../benchmark-schemas.js'
import {
  containment,
  iou,
  matchBoxes,
  normalisePixelBox,
  percentile,
  sizeBucket,
} from '../eval-geometry.js'

const box = (x: number, y: number, w: number, h: number): EvalBox => ({ x, y, w, h })

describe('eval geometry', () => {
  it('measures size buckets in the 640 view, not native pixels', () => {
    // 120×120 native px on a 4K frame is 20×20 in the view → small.
    expect(sizeBucket(box(0, 0, 120 / 3840, 120 / 2160), 3840, 2160)).toBe('small')
    // The same 120 px box on a 640 frame is 120² ≥ 96² in the view → large.
    expect(sizeBucket(box(0, 0, 120 / 640, 120 / 360), 640, 360)).toBe('large')
    expect(sizeBucket(box(0, 0, 60 / 640, 60 / 360), 640, 360)).toBe('medium')
  })

  it('computes IoU and containment', () => {
    expect(iou(box(0, 0, 0.2, 0.2), box(0, 0, 0.2, 0.2))).toBe(1)
    expect(iou(box(0, 0, 0.2, 0.2), box(0.5, 0.5, 0.2, 0.2))).toBe(0)
    expect(iou(box(0, 0, 0.2, 0.2), box(0.1, 0, 0.2, 0.2))).toBeCloseTo(1 / 3, 6)
    expect(containment(box(0.1, 0.1, 0.1, 0.1), box(0, 0, 0.5, 0.5))).toBe(1)
    expect(containment(box(0, 0, 0, 0), box(0, 0, 1, 1))).toBe(0)
  })

  it('matches one-to-one, same macro, highest score first, at IoU ≥ 0.5', () => {
    const gts = [{ macro: 'person', box: box(0.1, 0.1, 0.2, 0.2) }]
    const preds = [
      { macro: 'person', score: 0.6, box: box(0.1, 0.1, 0.2, 0.2) },
      { macro: 'person', score: 0.9, box: box(0.11, 0.1, 0.2, 0.2) },
      { macro: 'vehicle', score: 0.95, box: box(0.1, 0.1, 0.2, 0.2) },
    ]
    const m = matchBoxes(preds, gts)
    expect(m.pairs).toHaveLength(1)
    expect(m.pairs[0]?.pred).toBe(1)
    expect(m.unmatchedPreds.toSorted()).toEqual([0, 2])
    expect(m.unmatchedGts).toEqual([])
    // Below the threshold nothing matches.
    expect(
      matchBoxes([{ macro: 'person', score: 1, box: box(0.2, 0.1, 0.2, 0.2) }], gts).pairs,
    ).toHaveLength(0)
  })

  it('normalises a pixel bbox and clamps it to the frame', () => {
    expect(normalisePixelBox({ x: 320, y: 180, width: 64, height: 36 }, 640, 360)).toEqual(
      box(0.5, 0.5, 0.1, 0.1),
    )
    expect(normalisePixelBox({ x: 600, y: -10, width: 100, height: 50 }, 640, 360)).toEqual({
      x: 600 / 640,
      y: 0,
      w: 1 - 600 / 640,
      h: 50 / 360,
    })
  })

  it('answers null for a percentile over nothing, never 0', () => {
    expect(percentile([], 0.5)).toBeNull()
    expect(percentile([30, 10, 20], 0.5)).toBe(20)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10)
  })
})
