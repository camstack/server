/**
 * Generic length-prefix codec.
 *
 * Wire format: [4 bytes length (BE uint32)] [payload bytes]
 *
 * The length field is the size of the payload only (not including the
 * 4-byte prefix itself). Maximum payload size: 2^32 - 1 bytes. Single
 * frames larger than this will throw at encode time.
 *
 * Decode is stateful — callers feed raw bytes via `push()` and receive
 * 0+ complete payloads. Bytes straddling frame boundaries are buffered
 * internally until the next `push()` completes the frame.
 *
 * This codec is transport-agnostic. It's used on top of any stream-
 * oriented transport (TCP, UDS, in-process). It does NOT work for
 * datagram transports (UDP) — those need a different framing strategy
 * because the transport itself provides message boundaries.
 */
import type { FrameCodec, FrameDecoder } from '../types.js'

const LENGTH_PREFIX_BYTES = 4
/** Hard cap — 2^31-1 to stay safely within uint32 BE range and V8 Buffer limits. */
const MAX_PAYLOAD_BYTES = 0x7fffffff

export interface LengthPrefixCodecOptions<TMessage> {
  /** Encode a message to its payload bytes (without any length prefix). */
  readonly serialize: (msg: TMessage) => Uint8Array
  /** Decode a single complete payload back to a message. */
  readonly deserialize: (bytes: Uint8Array) => TMessage
  /** Codec identifier for diagnostics/metrics. */
  readonly kind?: string
}

export class LengthPrefixCodec<TMessage> implements FrameCodec<TMessage> {
  readonly kind: string
  private readonly serialize: (msg: TMessage) => Uint8Array
  private readonly deserialize: (bytes: Uint8Array) => TMessage

  constructor(options: LengthPrefixCodecOptions<TMessage>) {
    this.serialize = options.serialize
    this.deserialize = options.deserialize
    this.kind = options.kind ?? 'length-prefix'
  }

  encode(msg: TMessage): Uint8Array {
    const payload = this.serialize(msg)
    if (payload.length > MAX_PAYLOAD_BYTES) {
      throw new Error(
        `LengthPrefixCodec.encode: payload too large (${payload.length} bytes, max ${MAX_PAYLOAD_BYTES})`,
      )
    }
    const buf = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES + payload.length)
    buf.writeUInt32BE(payload.length, 0)
    buf.set(payload, LENGTH_PREFIX_BYTES)
    return buf
  }

  createDecoder(): FrameDecoder<TMessage> {
    return new LengthPrefixDecoder<TMessage>(this.deserialize)
  }
}

class LengthPrefixDecoder<TMessage> implements FrameDecoder<TMessage> {
  /** Accumulates bytes until at least one full frame is available. */
  private buffer = Buffer.alloc(0)
  private readonly deserialize: (bytes: Uint8Array) => TMessage

  constructor(deserialize: (bytes: Uint8Array) => TMessage) {
    this.deserialize = deserialize
  }

  push(chunk: Uint8Array): readonly TMessage[] {
    // Concat the new chunk onto the pending buffer. Allocation-light for the
    // common case where chunk already contains one or more complete frames.
    this.buffer =
      this.buffer.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.buffer, Buffer.from(chunk)])

    const out: TMessage[] = []
    let offset = 0

    while (true) {
      // Need at least the length prefix.
      if (this.buffer.length - offset < LENGTH_PREFIX_BYTES) break

      const payloadLen = this.buffer.readUInt32BE(offset)
      if (payloadLen > MAX_PAYLOAD_BYTES) {
        // Corrupted stream — reset to avoid cascading failures.
        this.buffer = Buffer.alloc(0)
        throw new Error(
          `LengthPrefixDecoder: declared payload length ${payloadLen} exceeds max ${MAX_PAYLOAD_BYTES}`,
        )
      }

      const totalFrameBytes = LENGTH_PREFIX_BYTES + payloadLen
      if (this.buffer.length - offset < totalFrameBytes) {
        // Frame is incomplete — wait for more bytes.
        break
      }

      const payloadStart = offset + LENGTH_PREFIX_BYTES
      const payloadEnd = payloadStart + payloadLen
      const payload = this.buffer.subarray(payloadStart, payloadEnd)
      out.push(this.deserialize(payload))
      offset = payloadEnd
    }

    // Trim the consumed prefix to free memory once per call (vs. per-frame).
    if (offset > 0) {
      this.buffer = this.buffer.subarray(offset)
    }

    return out
  }

  reset(): void {
    this.buffer = Buffer.alloc(0)
  }
}
