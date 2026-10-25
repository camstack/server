/**
 * The operator's layout, as one decoder child per CELL.
 *
 * ## Why per cell, when `grid-plan.ts` dedupes per source
 *
 * The single ffmpeg that this replaces made a camera used by two cells ONE
 * input, because decoding it twice doubles the expensive half of the job. A
 * compositor cannot do that with the same shape: this repo has exactly one
 * ffmpeg argv builder (`scripts/check-ffmpeg-primitive.ts`, Rule 1) and it
 * expresses one output per process, so a source feeding two differently cropped
 * and differently scaled tiles needs two children.
 *
 * The trade is small and worth stating: since D528 every source is read at its
 * CHEAPEST stream, so the duplicate is a second 640x360 sub-stream decode, not a
 * second 4 MP one. Teaching the builder several outputs would buy that back, and
 * is the right change to make if a grid ever shows one camera many times — it is
 * deliberately not made for a case that costs this little.
 *
 * ## Why the tile is scaled in the DECODER
 *
 * ffmpeg's scaler is SIMD and already there. Scaling in this process would be a
 * per-pixel loop in JavaScript, on the event loop that also answers the grid's
 * RPCs. Handing each child the exact pixel size its rectangle needs makes the
 * composition a strided memcpy (`grid-canvas.ts`) and keeps the only per-pixel
 * work where it belongs.
 *
 * ## Even, and snapped DOWN
 *
 * yuv420p subsamples chroma 2x2, so an odd origin lands a tile's chroma half a
 * sample off its luma — which TINTS the tile instead of breaking it, and
 * survives review. Sizes round DOWN so a tile never claims a row the decoder
 * was not asked to produce; a cell that rounds away to nothing is dropped
 * rather than emitted at zero size, because a zero-size output is an ffmpeg
 * start-up failure that would take the whole grid with it.
 */
import { evenDown, yuv420pSize, type PixelOrigin, type PixelSize } from './grid-canvas.js'
import type { NormalizedRect } from './grid-filter-graph.js'

/** Smallest tile worth decoding. Below this it is not a cheaper picture, it is none. */
const MIN_TILE_PX = 2

/** The one pixel format the canvas is in, so a blit is a copy and not a convert. */
export const TILE_PIXEL_FORMAT = 'yuv420p'

export interface GridTilePlanCell {
  readonly deviceId: number
  /** The part of the source to take, normalized against the SOURCE. */
  readonly source: NormalizedRect
  /** Where it lands, normalized against the CANVAS. */
  readonly cell: NormalizedRect
}

export interface GridTilePlanInput {
  readonly canvas: PixelSize
  readonly cells: readonly GridTilePlanCell[]
}

export interface GridTile {
  /** Unique within this composition — the key its frames arrive under. */
  readonly id: string
  readonly deviceId: number
  readonly size: PixelSize
  readonly origin: PixelOrigin
  /** Bytes one frame of this tile occupies — the feed's frame length. */
  readonly frameBytes: number
  /** The `-vf` chain its decoder runs: crop (when cropped), scale, format. */
  readonly filter: string
}

export interface GridTilePlan {
  readonly canvas: PixelSize
  readonly tiles: readonly GridTile[]
}

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
 * `crop` resolved against the source's OWN size at runtime (`iw`/`ih`), never
 * against a resolution guessed here — which is what lets a stored rectangle
 * survive a camera that changes resolution under us.
 */
function cropExpression(source: NormalizedRect): string {
  return `crop=iw*${source.width}:ih*${source.height}:iw*${source.x}:ih*${source.y}`
}

export function buildGridTilePlan(input: GridTilePlanInput): GridTilePlan {
  const tiles: GridTile[] = []
  for (const [index, cell] of input.cells.entries()) {
    const width = evenDown(cell.cell.width * input.canvas.width)
    const height = evenDown(cell.cell.height * input.canvas.height)
    if (width < MIN_TILE_PX || height < MIN_TILE_PX) continue
    // Clamp AFTER snapping: a cell dragged to the right edge can round to an
    // origin that plus its width overruns the canvas by one sample.
    const x = Math.min(
      evenDown(cell.cell.x * input.canvas.width),
      evenDown(input.canvas.width - width),
    )
    const y = Math.min(
      evenDown(cell.cell.y * input.canvas.height),
      evenDown(input.canvas.height - height),
    )
    tiles.push({
      // The CELL INDEX, not the device: one camera can hold two cells, and an
      // id that named only the device would make their frames indistinguishable.
      id: `cell-${String(index)}`,
      deviceId: cell.deviceId,
      size: { width, height },
      origin: { x, y },
      frameBytes: yuv420pSize(width, height),
      filter: [
        ...(isFullFrame(cell.source) ? [] : [cropExpression(cell.source)]),
        `scale=${String(width)}:${String(height)}`,
        // Stated, never inherited: the canvas copy is a memcpy only because
        // every tile arrives in the format the canvas is in.
        `format=${TILE_PIXEL_FORMAT}`,
      ].join(','),
    })
  }
  return { canvas: input.canvas, tiles }
}
