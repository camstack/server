/**
 * A detection seen by a SOURCE camera, placed where the operator can see it.
 *
 * The viewer feeds the detection ring and the box overlay from the SAME event
 * (`detection.result`), so a grid that reports detections reports boxes too,
 * whether or not anyone wanted them. Emitting the source's own pixel box would
 * draw it against the composed canvas — the wrong place, confidently. So the
 * box is carried through the cell's geometry, which is a multiplication: both
 * rectangles are normalized on both sides (D519).
 *
 * Three things this has to get right, and each of them is a way to be subtly
 * wrong rather than visibly broken:
 *
 *  - a camera can appear in SEVERAL cells (a wide shot and a crop of the same
 *    street is the case composites are asked for most), so one detection can
 *    land more than once, or not at all;
 *  - a cell shows only PART of its source, so a detection outside that part is
 *    not in the picture and must not be drawn at its edge;
 *  - a detection straddling the crop edge is really half-visible, so it is
 *    clipped to what the cell shows.
 */
import { describe, expect, it } from 'vitest'
import { mapDetectionToCanvas } from '../grid-detection-mapping.js'
import type { GridMappingCell } from '../grid-detection-mapping.js'

const FULL = { x: 0, y: 0, width: 1, height: 1 } as const
const SOURCE_FRAME = { width: 640, height: 360 } as const
const CANVAS = { width: 1920, height: 1080 } as const

/** Top-left quarter cell, showing the whole source. */
const TOP_LEFT: GridMappingCell = {
  source: FULL,
  cell: { x: 0, y: 0, width: 0.5, height: 0.5 },
}

/**
 * Compare at whole pixels. The mapping keeps full precision — a box is a
 * measurement and rounding it is the caller's business — so the arithmetic
 * lands on 191.99999999999994 where a reader means 192, and asserting the
 * float would pin the error term instead of the geometry.
 */
function px(boxes: readonly { x: number; y: number; width: number; height: number }[]) {
  return boxes.map((b) => ({
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height),
  }))
}

describe('mapDetectionToCanvas', () => {
  it('scales a full-source box into the cell it lands in', () => {
    // The middle 20% of the source, in source pixels.
    const boxes = mapDetectionToCanvas({
      bbox: { x: 256, y: 144, width: 128, height: 72 },
      sourceFrame: SOURCE_FRAME,
      canvas: CANVAS,
      cells: [TOP_LEFT],
    })
    expect(px(boxes)).toEqual([{ x: 384, y: 216, width: 192, height: 108 }])
  })

  it('places the SAME detection once per cell that shows it', () => {
    const boxes = mapDetectionToCanvas({
      bbox: { x: 0, y: 0, width: 640, height: 360 },
      sourceFrame: SOURCE_FRAME,
      canvas: CANVAS,
      cells: [TOP_LEFT, { source: FULL, cell: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } }],
    })
    expect(px(boxes)).toEqual([
      { x: 0, y: 0, width: 960, height: 540 },
      { x: 960, y: 540, width: 960, height: 540 },
    ])
  })

  it('drops a detection the cell does not SHOW — a crop is not a window onto everything', () => {
    // The cell shows only the left half of the source; the subject is on the right.
    const boxes = mapDetectionToCanvas({
      bbox: { x: 400, y: 0, width: 100, height: 100 },
      sourceFrame: SOURCE_FRAME,
      canvas: CANVAS,
      cells: [{ source: { x: 0, y: 0, width: 0.5, height: 1 }, cell: FULL }],
    })
    expect(px(boxes)).toEqual([])
  })

  it('CLIPS a detection that straddles the crop edge — half a subject is half visible', () => {
    // Cell shows the left half (0..320 px). Box spans 280..380.
    const boxes = mapDetectionToCanvas({
      bbox: { x: 280, y: 0, width: 100, height: 90 },
      sourceFrame: SOURCE_FRAME,
      canvas: CANVAS,
      cells: [{ source: { x: 0, y: 0, width: 0.5, height: 1 }, cell: FULL }],
    })
    // 280..320 of a 320-wide crop → 0.875..1 of the cell → 1680..1920 on canvas.
    expect(px(boxes)).toEqual([{ x: 1680, y: 0, width: 240, height: 270 }])
  })

  it('maps into a cropped cell without stretching the crop away', () => {
    // Cell shows the right half of the source, in the right half of the canvas.
    const boxes = mapDetectionToCanvas({
      bbox: { x: 320, y: 0, width: 320, height: 360 },
      sourceFrame: SOURCE_FRAME,
      canvas: CANVAS,
      cells: [
        {
          source: { x: 0.5, y: 0, width: 0.5, height: 1 },
          cell: { x: 0.5, y: 0, width: 0.5, height: 1 },
        },
      ],
    })
    expect(px(boxes)).toEqual([{ x: 960, y: 0, width: 960, height: 1080 }])
  })

  it('refuses a source frame with no size rather than dividing by zero', () => {
    expect(
      px(
        mapDetectionToCanvas({
          bbox: { x: 0, y: 0, width: 10, height: 10 },
          sourceFrame: { width: 0, height: 0 },
          canvas: CANVAS,
          cells: [TOP_LEFT],
        }),
      ),
    ).toEqual([])
  })
})
