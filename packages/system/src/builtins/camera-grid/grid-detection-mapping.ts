/**
 * A detection seen by a SOURCE camera, placed where the operator is looking.
 *
 * ## Why a grid maps boxes at all
 *
 * The viewer feeds the detection ring and the box overlay from the SAME event
 * (`detection.result`). So a grid that reports detections — which is what makes
 * its tile light up — reports boxes too, whether or not anyone asked for them.
 * The only choices are to send the source's own box, which would be drawn
 * against the composed canvas at confidently wrong coordinates, or to carry it
 * through the geometry the composition already uses. Both rectangles are
 * normalized on both sides (D519), so carrying it is a multiplication.
 *
 * ## Three ways to be subtly wrong
 *
 * - **A camera can appear in SEVERAL cells.** A wide shot and a crop of the
 *   same street is the case composites are asked for most, and `grid-plan.ts`
 *   already makes both read ONE input. One detection therefore lands once per
 *   cell that shows it — or not at all.
 * - **A cell shows only PART of its source.** A detection outside the crop is
 *   not in the picture, and drawing it at the cell's edge would invent a
 *   subject standing where nobody is.
 * - **A detection can straddle the crop edge.** Half a subject really is half
 *   visible, so the box is clipped to what the cell shows rather than dropped.
 *
 * This deliberately does not go through `deriveDetailCropRect` (D52): that
 * function exists to keep every crop feeding a VECTOR INDEX cut the same way.
 * This is presentation, feeds no index, and routing it through there would add
 * a second cutter to the one thing D52 keeps single.
 */
import type { DetectionBoundingBox } from '@camstack/types'
import type { NormalizedRect } from './grid-filter-graph.js'

/** One place a source appears: the part taken, and where that part lands. */
export interface GridMappingCell {
  /** The part of the source this cell shows, normalized against the SOURCE. */
  readonly source: NormalizedRect
  /** Where it lands, normalized against the CANVAS. */
  readonly cell: NormalizedRect
}

export interface GridFrameSize {
  readonly width: number
  readonly height: number
}

export interface MapDetectionInput {
  /** The detection's box, in ABSOLUTE pixels of the source frame. */
  readonly bbox: DetectionBoundingBox
  /** The frame those pixels are measured against (`FrameResult.width/height`). */
  readonly sourceFrame: GridFrameSize
  /** The composed canvas the result is measured against. */
  readonly canvas: GridFrameSize
  /** Every cell this source appears in. */
  readonly cells: readonly GridMappingCell[]
}

/**
 * Where this detection lands on the canvas — once per cell that shows it.
 *
 * Empty is a real answer: the subject is in a part of the source this grid does
 * not display, or the frame arrived with no size to measure against. Neither is
 * a reason to guess.
 */
export function mapDetectionToCanvas(input: MapDetectionInput): readonly DetectionBoundingBox[] {
  const { width: frameW, height: frameH } = input.sourceFrame
  // A frame with no size cannot be normalized against. It is not a detection
  // at the origin — it is a measurement that failed (D393), and zero is the one
  // answer it must not become.
  if (frameW <= 0 || frameH <= 0) return []

  // The box in the source's OWN normalized space, which is the space the cell's
  // crop rectangle is expressed in.
  const left = input.bbox.x / frameW
  const top = input.bbox.y / frameH
  const right = (input.bbox.x + input.bbox.width) / frameW
  const bottom = (input.bbox.y + input.bbox.height) / frameH

  const out: DetectionBoundingBox[] = []
  for (const { source, cell } of input.cells) {
    if (source.width <= 0 || source.height <= 0) continue
    // Clip to what this cell actually shows.
    const l = Math.max(left, source.x)
    const t = Math.max(top, source.y)
    const r = Math.min(right, source.x + source.width)
    const b = Math.min(bottom, source.y + source.height)
    if (r <= l || b <= t) continue

    // Into the cell's own space, then onto the canvas.
    const cx = (l - source.x) / source.width
    const cy = (t - source.y) / source.height
    const cw = (r - l) / source.width
    const ch = (b - t) / source.height
    out.push({
      x: (cell.x + cx * cell.width) * input.canvas.width,
      y: (cell.y + cy * cell.height) * input.canvas.height,
      width: cw * cell.width * input.canvas.width,
      height: ch * cell.height * input.canvas.height,
    })
  }
  return out
}
