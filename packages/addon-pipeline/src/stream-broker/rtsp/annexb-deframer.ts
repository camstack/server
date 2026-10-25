/**
 * Annex-B NAL unit deframer.
 *
 * ffmpeg outputs Annex-B via stdout in arbitrary chunk sizes — a single
 * `data` event may contain partial NALs, multiple NALs, or NALs split
 * across events. This class accumulates bytes and emits complete NAL units.
 *
 * Usage:
 *   const deframer = new AnnexBDeframer((nal, isKeyframe) => { ... })
 *   proc.stdout.on('data', chunk => deframer.push(chunk))
 */
export class AnnexBDeframer {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private readonly codec: 'h264' | 'h265'

  constructor(
    codec: 'h264' | 'h265',
    private readonly onNal: (nal: Buffer, keyframe: boolean) => void,
  ) {
    this.codec = codec
  }

  /** Push raw Annex-B bytes. Complete NAL units are emitted via onNal callback. */
  push(chunk: Buffer): void {
    this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk

    this.drain()
  }

  /** Flush remaining buffer (call on stream end). */
  flush(): void {
    if (this.buffer.length > 0) {
      const nal = this.stripLeadingStartCode(this.buffer)
      if (nal.length > 0) {
        this.onNal(nal, this.isKeyframeNal(nal))
      }
      this.buffer = Buffer.alloc(0)
    }
  }

  /** Extract complete NAL units from the buffer, leaving partial data for next push. */
  private drain(): void {
    while (true) {
      // Find first start code in buffer
      const firstSc = this.findStartCode(0)
      if (firstSc < 0) {
        // No start code found at all — keep everything (partial NAL or leading junk)
        return
      }

      // Find the NEXT start code after the first one
      const nalStart = firstSc + (this.isStartCode4(firstSc) ? 4 : 3)
      const nextSc = this.findStartCode(nalStart)

      if (nextSc < 0) {
        // Only one start code — NAL is not yet complete, wait for more data.
        // Keep buffer from firstSc onwards (discard junk before first start code).
        if (firstSc > 0) {
          this.buffer = Buffer.from(this.buffer.subarray(firstSc))
        }
        return
      }

      // We have a complete NAL between firstSc and nextSc
      const nal = this.buffer.subarray(nalStart, nextSc)
      if (nal.length > 0) {
        this.onNal(nal, this.isKeyframeNal(nal))
      }

      // Advance buffer past this NAL (keep from nextSc onwards)
      this.buffer = Buffer.from(this.buffer.subarray(nextSc))
    }
  }

  /** Find the byte offset of the next start code (00 00 01 or 00 00 00 01) at or after `from`. */
  private findStartCode(from: number): number {
    const buf = this.buffer
    const len = buf.length - 2
    for (let i = from; i < len; i++) {
      // Fast skip: if buf[i+2] is not 0 or 1, no start code can begin at i
      if (buf[i + 2]! > 1) {
        i += 2
        continue
      }
      if (buf[i] === 0 && buf[i + 1] === 0) {
        if (buf[i + 2] === 1) return i
        if (buf[i + 2] === 0 && i + 3 < buf.length && buf[i + 3] === 1) return i
      }
    }
    return -1
  }

  /** Check if start code at `pos` is 4-byte (00 00 00 01) vs 3-byte (00 00 01). */
  private isStartCode4(pos: number): boolean {
    return (
      pos + 3 < this.buffer.length &&
      this.buffer[pos] === 0 &&
      this.buffer[pos + 1] === 0 &&
      this.buffer[pos + 2] === 0 &&
      this.buffer[pos + 3] === 1
    )
  }

  /** Strip leading start code from a buffer (if present). */
  private stripLeadingStartCode(buf: Buffer): Buffer {
    if (buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 0 && buf[3] === 1) {
      return buf.subarray(4)
    }
    if (buf.length >= 3 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1) {
      return buf.subarray(3)
    }
    return buf
  }

  /** Check if a NAL unit (without start code) is a keyframe. */
  private isKeyframeNal(nal: Buffer): boolean {
    if (nal.length === 0) return false
    if (this.codec === 'h264') {
      const type = nal[0]! & 0x1f
      return type === 5 // IDR
    }
    const type = (nal[0]! >> 1) & 0x3f
    return type >= 16 && type <= 21 // IRAP
  }
}
