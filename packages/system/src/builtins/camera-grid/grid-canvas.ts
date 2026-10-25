/**
 * The composed picture as a buffer this addon owns.
 *
 * ## Why a canvas instead of ffmpeg's `overlay`
 *
 * `overlay` pairs its inputs BY PTS, and ffmpeg gives every input pts 0 at ITS
 * OWN first frame. Two sources that joined at different moments therefore
 * compose different moments, for the life of the child, with nothing to correct
 * it. Measured on this hub at 4-5 s between two tiles, drifting over hours as
 * the sources' key-frame phases slide through each other (0.5 s at 13:05, 3 s
 * at 13:50 on the same pair, 2026-09-18).
 *
 * It is not reachable from a flag. `-use_wallclock_as_timestamps` re-times by
 * ARRIVAL and wrecked the pacing instead (ten stalls over a second in an 18 s
 * run, against none). `-copyts` changes nothing, because the broker re-bases
 * each session — both restreams report `pts_time:0` — so there is no common
 * timeline to trim against. Serving each dial from the newest key frame it
 * already holds does not help either: those key frames are of different ages,
 * and pts 0 still lands on whatever arrives first.
 *
 * A canvas has no pairing to get wrong. When the output tick fires, each
 * rectangle holds whatever arrived last from its source, and the OUTPUT owns
 * the clock. The gap is zero by construction rather than by tuning, and a cell
 * that has produced nothing yet costs nothing — so the picture appears at once
 * instead of waiting for the slowest source's first key frame. What such a cell
 * shows is the seed the compositor blits in at construction
 * (`grid-canvas-seed.ts`); `clear()` below is what it shows without one.
 *
 * ## Why yuv420p, and why everything here must be even
 *
 * yuv420p is the one pixel format every consumer of a CamStack profile reads,
 * and a plane copy in it is a strided memcpy — no arithmetic per pixel, which
 * is the whole reason compositing can be cheaper than the filter graph it
 * replaces.
 *
 * Its chroma planes are half resolution in BOTH axes. So an odd origin or an
 * odd size would put a tile's chroma half a sample off its luma, and the result
 * is a tile that is subtly TINTED rather than visibly broken — the kind of
 * fault that survives review. Every rectangle is therefore required to be even,
 * and a blit that is not is refused rather than rounded: rounding would move a
 * cell the operator placed.
 */

export interface PixelSize {
  readonly width: number
  readonly height: number
}

export interface PixelOrigin {
  readonly x: number
  readonly y: number
}

/** Bytes one yuv420p frame of this size occupies. */
export function yuv420pSize(width: number, height: number): number {
  return width * height + 2 * (width / 2) * (height / 2)
}

/**
 * Round DOWN to even.
 *
 * Down and not nearest: a tile that rounded UP would claim a row of samples the
 * decoder was never asked to produce, and the copy would either overrun or be
 * refused at the moment the picture is wanted.
 */
export function evenDown(value: number): number {
  return Math.max(0, Math.floor(value / 2) * 2)
}

export class GridCanvas {
  readonly buffer: Buffer
  private readonly lumaBytes: number
  private readonly chromaBytes: number

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.lumaBytes = width * height
    this.chromaBytes = (width / 2) * (height / 2)
    this.buffer = Buffer.alloc(yuv420pSize(width, height))
    this.clear()
  }

  /**
   * Legible black — Y 0, chroma 128 (neutral).
   *
   * `Buffer.alloc` already zeroes, and zeroed CHROMA is not black: it is a
   * strong green. A cell nobody has filled yet has to look like an empty cell,
   * not like a fault.
   */
  clear(): void {
    this.buffer.fill(0, 0, this.lumaBytes)
    this.buffer.fill(128, this.lumaBytes)
  }

  /**
   * Copy one decoded tile in at `origin`.
   *
   * Returns false — never throws, never writes a partial tile — when the tile
   * does not fit, is the wrong size for the dimensions it claims, or sits on an
   * odd boundary. This runs on the output tick, so a bad frame from one source
   * must cost that source's rectangle and nothing else.
   */
  blit(tile: Buffer, size: PixelSize, origin: PixelOrigin): boolean {
    if (!isEven(size.width) || !isEven(size.height)) return false
    if (!isEven(origin.x) || !isEven(origin.y)) return false
    if (size.width <= 0 || size.height <= 0) return false
    if (origin.x < 0 || origin.y < 0) return false
    if (origin.x + size.width > this.width) return false
    if (origin.y + size.height > this.height) return false
    if (tile.length !== yuv420pSize(size.width, size.height)) return false

    // Luma.
    for (let row = 0; row < size.height; row += 1) {
      const from = row * size.width
      const to = (origin.y + row) * this.width + origin.x
      tile.copy(this.buffer, to, from, from + size.width)
    }
    // U then V, both at half resolution in each axis.
    const tileLuma = size.width * size.height
    const tileChroma = (size.width / 2) * (size.height / 2)
    const halfW = size.width / 2
    const halfH = size.height / 2
    const canvasHalfW = this.width / 2
    for (let plane = 0; plane < 2; plane += 1) {
      const tileBase = tileLuma + plane * tileChroma
      const canvasBase = this.lumaBytes + plane * this.chromaBytes
      for (let row = 0; row < halfH; row += 1) {
        const from = tileBase + row * halfW
        const to = canvasBase + (origin.y / 2 + row) * canvasHalfW + origin.x / 2
        tile.copy(this.buffer, to, from, from + halfW)
      }
    }
    return true
  }
}

function isEven(value: number): boolean {
  return Number.isInteger(value) && value % 2 === 0
}
