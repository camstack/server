/**
 * The composite's geometry, as the `-filter_complex` the extended ffmpeg
 * primitive carries.
 *
 * ## Why normalized, and why not `deriveDetailCropRect`
 *
 * Both rectangles -- the crop taken OUT of a source and the cell it lands IN --
 * are normalized [0,1]. A source camera can change resolution under us (a
 * profile switch, a firmware update, a substream that comes back different) and
 * a rectangle stored in pixels would quietly start cutting the wrong part of
 * the picture, with nothing to say so.
 *
 * This deliberately does NOT go through `deriveDetailCropRect`. D52 -- "one
 * vector index = one crop derivation" -- protects the COMPARABILITY of a vector
 * index: every crop that feeds it must be cut the same way. This is
 * presentation, feeds no index, and routing it through that function would add
 * a second cutter to the one thing D52 exists to keep single.
 *
 * ## Why a canvas and overlays rather than stacks
 *
 * `hstack`/`vstack` only express a regular grid of equal tiles. The operator
 * composes *arbitrary* rectangles -- "a 16:9 from the middle of two streams" is
 * the case this was asked for -- so every cell is scaled and overlaid onto one
 * explicit canvas at its own origin. The canvas is also what makes a missing
 * cell legible: a gap is black, not a stretched neighbour.
 */

/** A rectangle in normalized [0,1] coordinates of whatever contains it. */
export interface NormalizedRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** One source, the part of it taken, and where that part lands. */
export interface GridCell {
  /** Which ffmpeg input this cell reads — its ORDINAL among the invocation's inputs. */
  readonly inputIndex: number
  /** The part of the source to take, normalized against the SOURCE. */
  readonly source: NormalizedRect
  /** Where it lands, normalized against the CANVAS. */
  readonly cell: NormalizedRect
}

export interface GridLayout {
  /** Canvas size in pixels — the composite camera's own resolution. */
  readonly width: number
  readonly height: number
  readonly cells: readonly GridCell[]
}

export interface GridFilterGraph {
  readonly graph: string
  readonly videoOutLabel: string
}

const CANVAS_LABEL = 'canvas'
const OUT_LABEL = 'grid'
/** Full-frame within a tolerance, i.e. nothing to crop. */
const FULL_FRAME_EPSILON = 1e-6

function isFullFrame(rect: NormalizedRect): boolean {
  return (
    Math.abs(rect.x) < FULL_FRAME_EPSILON &&
    Math.abs(rect.y) < FULL_FRAME_EPSILON &&
    Math.abs(rect.width - 1) < FULL_FRAME_EPSILON &&
    Math.abs(rect.height - 1) < FULL_FRAME_EPSILON
  )
}

/**
 * yuv420p subsamples chroma 2x2, so an odd width or height is rejected by every
 * encoder we use. Rounding here lets the reason be stated; rounding inside the
 * child is a start-up failure with no context.
 */
function toEven(value: number): number {
  const rounded = Math.round(value)
  const even = rounded % 2 === 0 ? rounded : rounded - 1
  return Math.max(2, even)
}

function assertWithin(rect: NormalizedRect, what: string, cellIndex: number): void {
  const outside =
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.x + rect.width > 1 + FULL_FRAME_EPSILON ||
    rect.y + rect.height > 1 + FULL_FRAME_EPSILON
  if (outside) {
    throw new Error(
      `camera-grid: cell ${cellIndex} falls ${what} ` +
        `(x=${rect.x} y=${rect.y} w=${rect.width} h=${rect.height}) — ` +
        'ffmpeg would render this as a silently clipped picture',
    )
  }
}

/**
 * `crop` resolved against the source's OWN size at runtime (`iw`/`ih`), never
 * against a resolution guessed here. That is what makes the stored rectangle
 * survive a source that changes resolution.
 */
function cropExpression(source: NormalizedRect): string {
  return `crop=iw*${source.width}:ih*${source.height}:iw*${source.x}:ih*${source.y}`
}

export function buildGridFilterGraph(layout: GridLayout): GridFilterGraph {
  if (layout.cells.length === 0) {
    throw new Error('camera-grid: a composite needs at least one cell to emit anything')
  }

  const steps: string[] = [
    // The canvas is explicit so a gap reads as a gap. `d=1` keeps it a single
    // frame that overlay repeats, rather than a second live source.
    `color=c=black:s=${layout.width}x${layout.height}:d=1[${CANVAS_LABEL}]`,
  ]

  const cellLabels: string[] = []
  layout.cells.forEach((cell, index) => {
    assertWithin(cell.source, 'outside its source', index)
    assertWithin(cell.cell, 'outside the canvas', index)

    const targetWidth = toEven(cell.cell.width * layout.width)
    const targetHeight = toEven(cell.cell.height * layout.height)
    const label = `c${index}`
    const filters = [
      ...(isFullFrame(cell.source) ? [] : [cropExpression(cell.source)]),
      `scale=${targetWidth}:${targetHeight}`,
    ]
    steps.push(`[${cell.inputIndex}:v]${filters.join(',')}[${label}]`)
    cellLabels.push(label)
  })

  let base = CANVAS_LABEL
  layout.cells.forEach((cell, index) => {
    const x = Math.round(cell.cell.x * layout.width)
    const y = Math.round(cell.cell.y * layout.height)
    const isLast = index === layout.cells.length - 1
    const out = isLast ? OUT_LABEL : `s${index}`
    steps.push(`[${base}][${cellLabels[index]}]overlay=${x}:${y}[${out}]`)
    base = out
  })

  return { graph: steps.join(';'), videoOutLabel: OUT_LABEL }
}
