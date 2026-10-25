/**
 * clip-stream-audio — the container sample a clip stream delivers, turned
 * into the frame an RTP sender puts on the wire, without a decode (D600).
 *
 * The provider transcodes a clip's AAC into the session's own codec before it
 * muxes (there is one ffmpeg on that side already, and putting the encode
 * anywhere else would mean a second one here, fed incrementally, with its own
 * backlog outside the consumer's bound). So everything this module does is
 * FRAMING — no decode, no resample, no companding — and the two codecs need
 * different amounts of it:
 *
 * - **Opus**: an mp4 Opus sample IS one Opus packet, which IS one RTP
 *   payload. The unit passes through untouched, and `durationMs` is the
 *   packet's own. This is the same fact `segment-audio-js.ts` leans on for
 *   the stored path.
 * - **µ-law**: `pcm_mulaw` is one byte per 8 kHz sample and ffmpeg emits it in
 *   whatever run the muxer had ready — 512 bytes (64 ms) in the measured
 *   output, and not a multiple of a frame. WebRTC wants fixed 160-byte
 *   (20 ms) frames, so the bytes are re-cut here with a CARRY across samples,
 *   exactly as `sliceMuLawToPcmuFrames` cuts a whole fragment.
 *
 * ## Why the timestamp is counted, not copied
 *
 * A µ-law frame's `ptsMs` is derived from a running BYTE count off one
 * anchor, not from the container sample it happened to be cut out of: at
 * 8 kHz a byte is exactly 0.125 ms, so counting is exact for ever, while
 * re-deriving each frame from its sample's rounded `ptsMs` would accumulate
 * a rounding error over a 200-second clip — the drift that shows up only in
 * the ear, and only on a long clip.
 *
 * A container sample whose `ptsMs` disagrees with the count by more than
 * {@link PCMU_REANCHOR_TOLERANCE_MS} is a GAP in the audio, not a rounding
 * error: the carry is dropped, the anchor moves to the sample, and the
 * re-anchor is counted so a caller can say it happened. Silently stretching
 * the count across a gap would slide every later frame.
 */
import type { Fmp4AudioCodec, Fmp4AudioUnit } from './fmp4-stream-demux.js'

/** One audio frame, ready for the session's audio sender. */
export interface ClipAudioFrame {
  readonly data: Uint8Array
  /** Milliseconds on the stream's ONE origin — the video's axis too. */
  readonly ptsMs: number
  readonly durationMs: number
}

/** PCMU target: 8 kHz mono, 160 samples (20 ms) per RTP frame. */
export const PCMU_FRAME_BYTES = 160
export const PCMU_FRAME_MS = 20
export const PCMU_RATE_HZ = 8_000

/**
 * How far a µ-law sample's own `ptsMs` may sit from the running count before
 * it is treated as a gap. One frame: below that it is the container's
 * millisecond rounding, above it the stream really skipped.
 */
export const PCMU_REANCHOR_TOLERANCE_MS = PCMU_FRAME_MS

export interface ClipAudioFramer {
  /** Frame one container sample. Never throws; an empty sample yields none. */
  push(unit: Fmp4AudioUnit): readonly ClipAudioFrame[]
  /** Bytes held back because they do not fill a frame yet. */
  readonly carriedBytes: number
  /** Times the running count was moved onto a sample's own timestamp. */
  readonly reanchors: number
}

function createPassthroughFramer(): ClipAudioFramer {
  return {
    push: (unit) =>
      unit.data.byteLength === 0
        ? []
        : [{ data: unit.data, ptsMs: unit.ptsMs, durationMs: unit.durationMs }],
    carriedBytes: 0,
    reanchors: 0,
  }
}

class PcmuFramer implements ClipAudioFramer {
  private carry: Uint8Array = new Uint8Array(0)
  /** `ptsMs` of the first byte currently held in {@link carry}. */
  private anchorMs: number | null = null
  /** Bytes emitted plus carried since {@link anchorMs} — the exact clock. */
  private bytesSinceAnchor = 0
  private reanchorCount = 0

  get carriedBytes(): number {
    return this.carry.byteLength
  }

  get reanchors(): number {
    return this.reanchorCount
  }

  push(unit: Fmp4AudioUnit): readonly ClipAudioFrame[] {
    if (unit.data.byteLength === 0) return []
    const expectedMs =
      this.anchorMs === null ? null : this.anchorMs + (this.bytesSinceAnchor * 1000) / PCMU_RATE_HZ
    if (expectedMs === null || Math.abs(expectedMs - unit.ptsMs) > PCMU_REANCHOR_TOLERANCE_MS) {
      if (expectedMs !== null) this.reanchorCount += 1
      // A gap: the bytes held belong to the run that ended, and a frame built
      // across the seam would carry neither side's timestamp.
      this.carry = new Uint8Array(0)
      this.anchorMs = unit.ptsMs
      this.bytesSinceAnchor = 0
    }
    const anchorMs = this.anchorMs
    if (anchorMs === null) return []
    const joined = new Uint8Array(this.carry.byteLength + unit.data.byteLength)
    joined.set(this.carry, 0)
    joined.set(unit.data, this.carry.byteLength)
    const out: ClipAudioFrame[] = []
    let at = 0
    while (at + PCMU_FRAME_BYTES <= joined.byteLength) {
      out.push({
        data: joined.slice(at, at + PCMU_FRAME_BYTES),
        // Counted, never re-derived from the sample: exact at 8 kHz for ever.
        ptsMs: anchorMs + (this.bytesSinceAnchor * 1000) / PCMU_RATE_HZ,
        durationMs: PCMU_FRAME_MS,
      })
      this.bytesSinceAnchor += PCMU_FRAME_BYTES
      at += PCMU_FRAME_BYTES
    }
    this.carry = joined.slice(at)
    return out
  }
}

/** The framer for a codec: a pass-through for Opus, a re-cut for µ-law. */
export function createClipAudioFramer(codec: Fmp4AudioCodec): ClipAudioFramer {
  return codec === 'opus' ? createPassthroughFramer() : new PcmuFramer()
}
