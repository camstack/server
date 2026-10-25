/**
 * The canvas is a RESULT, not a field.
 *
 * ## Why the operator stopped typing it
 *
 * A grid's resolution used to be two numbers in the editor, beside FPS. They
 * looked harmless and were not: that number silently decided how much the
 * composite cost and how sharp it was. An operator typing 1920x1080 was, without
 * being told, committing the hub to reading two 4 MP streams — or, with the
 * rule before it, to upscaling a 640x360 sub-stream by 3x. Neither is a thing
 * anyone can be expected to work out from a text field.
 *
 * ## What it is derived from
 *
 * The operator draws two rectangles per camera — which part of the source to
 * take, and where it lands — and both are fractions, so nothing is pixels yet.
 * Exactly one number is missing: how many pixels the whole canvas is worth.
 *
 * A cell has `sourceResolution x crop` REAL pixels behind it. Showing them 1:1
 * neither invents nor discards anything, so the cell should be exactly that
 * many pixels — and since the cell is a fraction `f` of the canvas, the canvas
 * it implies is `real / f`. Each cell proposes one, and the LARGEST wins: the
 * hungriest cell is served 1:1 and the others scale down by a hair, never up.
 *
 * Gaps change nothing. Cells need not cover the canvas, and an uncovered part
 * is background — it has no pixels to propose.
 *
 * ## One per profile
 *
 * A source is a different size at each profile, so each profile derives its own
 * canvas: a grid's `low` composes its sources' `low` onto the canvas their
 * `low` implies. That is what makes the three outputs 1:1 with what they are
 * made of, and what lets a viewer's adaptive pick a rung without the grid
 * needing to know it exists.
 */
import { evenDown, type PixelSize } from './grid-canvas.js'
import type { NormalizedRect } from './grid-filter-graph.js'

/**
 * What an encoder will take. Not a taste: `libx264` refuses beyond 8192 in
 * either axis, and a canvas that large is a composition nobody can decode
 * anyway. Reached only by a cell that shows a sliver of a source at full
 * canvas width, which is a layout, not a mistake — so it is CLAMPED rather
 * than refused, and clamped in both axes together so the picture the operator
 * drew keeps its shape.
 */
const MAX_CANVAS_WIDTH = 7680
const MAX_CANVAS_HEIGHT = 4320
/** Below this a composition is not a cheaper picture, it is no picture. */
const MIN_CANVAS_EDGE = 160

export interface GridCanvasCell {
  /** The part of the source this cell shows, normalized against the SOURCE. */
  readonly source: NormalizedRect
  /** Where it lands, normalized against the CANVAS. */
  readonly cell: NormalizedRect
  /** The source's size AT THE PROFILE being derived for. */
  readonly sourceSize: PixelSize
}

/**
 * The canvas these cells imply, or `null` when they imply none.
 *
 * `null` for a grid with no cells — the normal freshly-created state — and for
 * a layout whose every rectangle is degenerate. Both are "there is no picture
 * to size", which the caller turns into "this profile is not on offer" rather
 * than into a guess.
 */
export function deriveGridCanvas(cells: readonly GridCanvasCell[]): PixelSize | null {
  let width = 0
  let height = 0
  for (const entry of cells) {
    if (entry.cell.width <= 0 || entry.cell.height <= 0) continue
    if (entry.sourceSize.width <= 0 || entry.sourceSize.height <= 0) continue
    const realWidth = entry.sourceSize.width * entry.source.width
    const realHeight = entry.sourceSize.height * entry.source.height
    if (realWidth <= 0 || realHeight <= 0) continue
    width = Math.max(width, realWidth / entry.cell.width)
    height = Math.max(height, realHeight / entry.cell.height)
  }
  if (width <= 0 || height <= 0) return null

  // Both bounds are applied as ONE factor across both axes. Clamping the axes
  // independently would change the aspect of the picture the operator laid
  // out, which is the one thing this function must not do — and it did: a
  // layout implying 38x22 came back 160x160, square.
  const overshoot = Math.max(width / MAX_CANVAS_WIDTH, height / MAX_CANVAS_HEIGHT, 1)
  const undershoot = Math.max(MIN_CANVAS_EDGE / width, MIN_CANVAS_EDGE / height, 1)
  const factor = undershoot / overshoot
  return {
    width: Math.max(2, evenDown(width * factor)),
    height: Math.max(2, evenDown(height * factor)),
  }
}
