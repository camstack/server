/**
 * A persisted grid row → the composition plan the stream session runs.
 *
 * The one piece of real work here is the source→ordinal mapping. The operator
 * authors cells against CAMERAS; ffmpeg addresses them by INPUT ORDINAL, and a
 * camera used by two cells must be ONE input. Two views of one camera — a wide
 * shot and a crop of the same street — is the case a composite is asked for
 * most often, and decoding it twice doubles the expensive half of the job for
 * no extra picture.
 */
import type { FfmpegVideoEncoderId } from '@camstack/types'
import type { GridCell, GridLayout } from './grid-filter-graph.js'
import type { GridInstance } from './grid-instances.js'
import type { GridStreamPlan } from './grid-stream-session.js'

export interface GridPlanEncodeContext {
  readonly encoder: FfmpegVideoEncoderId
  readonly decodeHwAccel: string | null
  /**
   * The canvas to compose onto. REQUIRED, and never authored: each profile
   * derives its own from the cells and its sources' size
   * (`grid-canvas-derivation.ts`). It used to fall back to two numbers the
   * operator typed into the editor, and that field is gone — it silently
   * decided both what the composite cost and how sharp it was.
   *
   * The geometry needs no second version of itself: every rectangle is
   * normalized on both sides (D519), so the same fractions land correctly on a
   * canvas of any size.
   */
  readonly canvas: { readonly width: number; readonly height: number }
}

/**
 * Bits per pixel per frame. A composite is mostly static furniture with a few
 * moving subjects, so it compresses well; this lands a 1920x1080@10 grid near
 * 3 Mbps and a 640x360@10 one near 0.35 Mbps. A single flat number would either
 * starve a 4K canvas or spend a 4K budget on a thumbnail-sized one.
 */
const BITS_PER_PIXEL_PER_FRAME = 0.15
const MIN_BITRATE_KBPS = 256
const MAX_BITRATE_KBPS = 16_000

function bitrateFor(width: number, height: number, fps: number): number {
  const bps = width * height * fps * BITS_PER_PIXEL_PER_FRAME
  return Math.min(MAX_BITRATE_KBPS, Math.max(MIN_BITRATE_KBPS, Math.round(bps / 1000)))
}

/** `null` when the grid has nothing to compose — the normal freshly-created state. */
export function gridPlanFor(
  instance: GridInstance,
  encode: GridPlanEncodeContext,
): GridStreamPlan | null {
  if (instance.cells.length === 0) return null

  const ordinalByDeviceId = new Map<number, number>()
  const sourceDeviceIds: number[] = []
  const cells: GridCell[] = instance.cells.map((cell) => {
    let ordinal = ordinalByDeviceId.get(cell.deviceId)
    if (ordinal === undefined) {
      ordinal = sourceDeviceIds.length
      ordinalByDeviceId.set(cell.deviceId, ordinal)
      sourceDeviceIds.push(cell.deviceId)
    }
    return { inputIndex: ordinal, source: cell.source, cell: cell.cell }
  })

  const canvas = encode.canvas
  const layout: GridLayout = { width: canvas.width, height: canvas.height, cells }
  return {
    layout,
    sourceDeviceIds,
    encoder: encode.encoder,
    decodeHwAccel: encode.decodeHwAccel,
    fps: instance.fps,
    // Derived from the canvas that is ACTUALLY encoded, not the one authored:
    // a `low` at the `high` bitrate spends the whole saving the profile exists
    // to make.
    bitrateKbps: bitrateFor(canvas.width, canvas.height, instance.fps),
  }
}
