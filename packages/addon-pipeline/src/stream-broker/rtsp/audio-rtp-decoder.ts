/**
 * Native audio RTP chunker for G.711 PCMU (μ-law) and PCMA (A-law).
 *
 * IP cameras almost universally use G.711 for audio (8 kHz, mono). This class
 * strips the RTP header and buffers the CODED payload bytes into ~0.5 s chunks
 * for the audio chunk plane. It decodes nothing.
 *
 * ## Why it stopped decoding
 *
 * It used to upsample 8 → 16 kHz by linear interpolation, "to match the ffmpeg
 * path". D450 removed the interpolation — the plane carries the source RATE,
 * and the one consumer that needs 16 kHz (the classifier) resamples next to
 * the model. That left one expansion still standing in front of the transport:
 * each G.711 byte became a 4-byte f32le sample HERE, so all four legs the
 * plane crosses between the broker and the analyzer carried four times the
 * source. Measured after D450: 37 KB per one-second window, 49 MB/min on the
 * analyzer leg alone.
 *
 * The same argument applies to the format as to the rate, so the plane carries
 * the source BYTES and whoever needs floats expands them where it needs them:
 * `expandAudioChunkToF32le` in `@camstack/types`, called by the consumer's
 * window accumulator — and, for a subscriber that did not declare it can read
 * coded bytes, by `AudioChunkPlane` itself. Measured cost of the expansion
 * where it now lands: 11.6 µs per one-second window per camera, and it is
 * MOVED rather than added — this file paid 12.3 µs for the same work
 * (`scripts/bench-audio-g711-expand.mts`). (D455)
 *
 * Output: 8 kHz mono, `format: 'pcmu' | 'pcma'`, one byte per sample, 4000
 * bytes per 500 ms chunk. A consumer that assumes f32le instead of reading the
 * field is the bug — but it cannot be handed these bytes by accident, because
 * the broker only serves them to a subscription whose `accept` named them.
 */

import type { AudioChunkFormat, DecodedAudioChunk } from '@camstack/types'

export type AudioCodec = 'PCMU' | 'PCMA'

/** G.711 is 8 kHz by definition (RFC 3551): the plane carries that rate. */
export const G711_SAMPLE_RATE = 8000
/** Buffer ~0.5 s of audio before emitting a chunk (the plane's cadence). */
const CHUNK_DURATION_MS = 500
/** One G.711 byte is one sample, so samples and bytes are the same count. */
const CHUNK_BYTES = (G711_SAMPLE_RATE * CHUNK_DURATION_MS) / 1000 // 4000

/** The chunk `format` each RTP codec produces. */
const CODEC_FORMAT: Readonly<Record<AudioCodec, AudioChunkFormat>> = {
  PCMU: 'pcmu',
  PCMA: 'pcma',
}

/**
 * Chunks G.711 audio RTP payloads into ~0.5 s coded chunks at 8 kHz.
 *
 * Buffers payload bytes and emits a `DecodedAudioChunk` carrying the source
 * codec once ~0.5 s has accumulated (4000 bytes).
 */
export class AudioRtpDecoder {
  private readonly format: AudioChunkFormat
  private readonly onChunk: (chunk: DecodedAudioChunk) => void
  private readonly buffer: Buffer
  private bufferOffset = 0

  constructor(codec: AudioCodec, onChunk: (chunk: DecodedAudioChunk) => void) {
    this.format = CODEC_FORMAT[codec]
    this.onChunk = onChunk
    this.buffer = Buffer.allocUnsafe(CHUNK_BYTES)
  }

  /**
   * Process a raw RTP packet (header + payload). Strips the 12-byte RTP header
   * and appends the payload bytes verbatim, emitting whenever a chunk fills.
   * A payload larger than the remaining room spans chunks.
   */
  processPacket(rtpData: Buffer): void {
    // RTP header is 12 bytes minimum (no CSRC, no extensions handled here)
    if (rtpData.length <= 12) return

    const payload = rtpData.subarray(12)
    let consumed = 0
    while (consumed < payload.length) {
      const room = CHUNK_BYTES - this.bufferOffset
      const take = Math.min(room, payload.length - consumed)
      payload.copy(this.buffer, this.bufferOffset, consumed, consumed + take)
      this.bufferOffset += take
      consumed += take
      if (this.bufferOffset >= CHUNK_BYTES) this.emit()
    }
  }

  /** Flush any remaining buffered bytes as a partial chunk. */
  flush(): void {
    if (this.bufferOffset === 0) return
    this.emit()
  }

  /** Reset the chunker state. */
  reset(): void {
    this.bufferOffset = 0
  }

  /**
   * Emit what is buffered and start a fresh chunk. The bytes are COPIED out:
   * the accumulator is reused, and the plane holds every queued chunk by
   * reference until its consumer polls.
   */
  private emit(): void {
    this.onChunk({
      data: Buffer.from(this.buffer.subarray(0, this.bufferOffset)),
      sampleRate: G711_SAMPLE_RATE,
      channels: 1,
      timestamp: Date.now(),
      format: this.format,
    })
    this.bufferOffset = 0
  }
}
