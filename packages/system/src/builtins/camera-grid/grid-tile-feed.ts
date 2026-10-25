/**
 * One source's decoded tiles, of which only the LATEST is ever wanted.
 *
 * ## Why dropping is the point, not a compromise
 *
 * ffmpeg's `overlay` consumes one frame per input per output frame, so an input
 * that got ahead of another stays ahead for the life of the child — that is the
 * tile gap. A canvas asks a different question: "what does this camera look
 * like NOW". Everything behind the newest frame is not a backlog to work
 * through, it is history, and dropping it is what keeps every tile at the same
 * moment however unevenly their frames arrive.
 *
 * It is also the only bound on memory here. A decoder child that outruns the
 * output tick — or a tick that stalls — would otherwise grow an unbounded queue
 * of raw frames, and a raw frame is 345 KB at 640x360.
 *
 * ## The last frame is HELD
 *
 * A tick that finds nothing new redraws what was there. A tile must not blink
 * because a source was 40 ms late, and a source that has genuinely stopped is a
 * still picture — which is legible, and which the snapshot path already treats
 * as the honest answer for a camera that is not sending.
 */
export class GridTileFeed {
  private partial: Buffer = Buffer.alloc(0)
  private newest: Buffer | null = null
  private fresh = false

  constructor(private readonly frameBytes: number) {}

  /** Feed bytes from the decoder. Any whole frames inside replace the newest. */
  push(chunk: Buffer): void {
    let buf = this.partial.length === 0 ? chunk : Buffer.concat([this.partial, chunk])
    while (buf.length >= this.frameBytes) {
      // `subarray` is a view over `buf`, and `buf` is dropped at the end of the
      // loop — except on the last iteration, where the view is kept. Copy it,
      // or the retained frame would pin whatever chunk it came in with.
      this.newest = Buffer.from(buf.subarray(0, this.frameBytes))
      this.fresh = true
      buf = buf.subarray(this.frameBytes)
    }
    this.partial = buf.length === 0 ? Buffer.alloc(0) : Buffer.from(buf)
  }

  /** The newest whole frame, or `null` while none has arrived. */
  latest(): Buffer | null {
    this.fresh = false
    return this.newest
  }

  /** Has a new frame arrived since the last {@link latest}? */
  hasFresh(): boolean {
    return this.fresh
  }

  /**
   * Forget the half frame, keep the picture.
   *
   * Raw video has no framing: the feed cuts on a fixed length, so bytes from a
   * NEW decoder concatenated onto a partial frame from the old one would be
   * misaligned for ever — every frame after it sheared, with nothing to
   * re-sync on. Called whenever a tile's decoder is replaced.
   *
   * The newest frame is kept deliberately: the cell holds its last picture
   * while its decoder comes back, instead of blinking to black.
   */
  resetPartial(): void {
    this.partial = Buffer.alloc(0)
  }

  /** For the bound in the spec: one frame plus at most a partial one. */
  bufferedBytes(): number {
    return (this.newest?.length ?? 0) + this.partial.length
  }
}
