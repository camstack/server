import { decode, encode } from '@msgpack/msgpack'

/**
 * `ignoreUndefined: true` makes the codec mirror JS/JSON semantics: an
 * `undefined` object property is OMITTED from the encoded map (and reads back
 * as `undefined`), while an explicit `null` is encoded as MsgPack nil (and
 * reads back as `null`). Without this, MsgPack collapses both to nil → `null`,
 * which breaks `z.void()` cap-method outputs (the void return decodes as
 * `null` and fails the hub's output validation) and would likewise turn an
 * optional `undefined` argument into `null` on the wire. Moleculer's JSON
 * serializer preserved this distinction; the UDS transport must too.
 */
const ENCODE_OPTIONS = { ignoreUndefined: true } as const

/** Encode a value as a length-prefixed (4-byte big-endian) MsgPack frame. */
export function encodeFrame(value: unknown): Buffer {
  const body = encode(value, ENCODE_OPTIONS)
  const out = Buffer.allocUnsafe(4 + body.byteLength)
  out.writeUInt32BE(body.byteLength, 0)
  Buffer.from(body.buffer, body.byteOffset, body.byteLength).copy(out, 4)
  return out
}

/**
 * The key under which an opaque payload rides on a frame — see
 * {@link encodeFrameHead}. Short on purpose: it is written once per frame by
 * hand, and it is the one msgpack key on this plane a decoder must never
 * interpret.
 */
export const PAYLOAD_KEY = 'pl'

/** msgpack `fixstr` of {@link PAYLOAD_KEY}: `0xa0 | length`, then the bytes. */
const PAYLOAD_KEY_BYTES = Buffer.from([0xa0 | PAYLOAD_KEY.length, ...Buffer.from(PAYLOAD_KEY)])

/** msgpack `bin 32` marker: one byte, then a 4-byte big-endian length. */
const BIN32_MARKER = 0xc6

/** msgpack `fixmap` range: `0x80 | count`, count in `0..15`. */
const FIXMAP_BASE = 0x80
const FIXMAP_MAX_COUNT = 0x0f

/**
 * Encode the HEAD of a frame that carries an opaque payload: the length
 * prefix, the msgpack envelope with one extra key ({@link PAYLOAD_KEY}), and
 * the `bin 32` header for the payload — everything but the payload bytes
 * themselves, which the caller writes straight after it.
 *
 * ## Why the payload is the frame's TAIL and not a field
 *
 * hub-main routes every sibling↔sibling call. Until this existed it decoded
 * the whole request (args included), built a new message, and re-encoded it
 * — walking a 13.5 KB PCM chunk or a 2 000-row settings answer twice on the
 * one thread that serves every tRPC request, and allocating an `Encoder`
 * buffer that doubles from 2 KiB up to the body's size on every write
 * (D441: ~27 % of hub-main's busy time in msgpack decode, ~6 % in encode,
 * and the churn that fed a 29.5 % GC share).
 *
 * With the payload appended as the LAST key of the map, the receiver's
 * ordinary msgpack decode yields it as a zero-copy VIEW of the frame
 * (`@msgpack/msgpack` decodes `bin` as `subarray`), the router reads only the
 * envelope, and forwarding is: encode a ~60-byte head, write it, write the
 * view. The wire stays plain msgpack — a peer that never heard of payloads
 * decodes `{ …frame, pl: <bytes> }` and can be told, at register, not to be
 * sent one.
 *
 * ## The one hand-written msgpack in this repository
 *
 * `@msgpack/msgpack` has no "encode a map, then append a key" API, so the
 * envelope is encoded normally and its `fixmap` count byte is bumped by one
 * before the key and the `bin 32` header are appended. That patch is only
 * valid for a `fixmap` (≤ 15 keys); a `Frame` has at most four, and anything
 * else is refused rather than silently corrupted.
 */
export function encodeFrameHead(frame: Record<string, unknown>, payload: Uint8Array): Buffer {
  const envelope = encode(frame, ENCODE_OPTIONS)
  const first = envelope[0]
  if (
    envelope.byteLength === 0 ||
    first === undefined ||
    first < FIXMAP_BASE ||
    first > FIXMAP_BASE + FIXMAP_MAX_COUNT - 1
  ) {
    throw new Error(
      `encodeFrameHead: envelope must be a msgpack fixmap with at most ${FIXMAP_MAX_COUNT - 1} keys (got leading byte 0x${(first ?? 0).toString(16)})`,
    )
  }
  const bodyLength = envelope.byteLength + PAYLOAD_KEY_BYTES.byteLength + 5 + payload.byteLength
  const head = Buffer.allocUnsafe(
    HEADER_BYTES + envelope.byteLength + PAYLOAD_KEY_BYTES.byteLength + 5,
  )
  head.writeUInt32BE(bodyLength, 0)
  Buffer.from(envelope.buffer, envelope.byteOffset, envelope.byteLength).copy(head, HEADER_BYTES)
  // One more key than the encoder wrote: the payload.
  head[HEADER_BYTES] = first + 1
  let at = HEADER_BYTES + envelope.byteLength
  PAYLOAD_KEY_BYTES.copy(head, at)
  at += PAYLOAD_KEY_BYTES.byteLength
  head[at] = BIN32_MARKER
  head.writeUInt32BE(payload.byteLength, at + 1)
  return head
}

/**
 * Serialise a value into the bytes a payload carries. The SAME options as the
 * envelope codec, so `undefined` properties are omitted rather than turned
 * into `null` — a `z.void()` cap output must read back as `undefined` on the
 * far side exactly as it did when it travelled inline.
 */
export function packPayload(value: unknown): Uint8Array {
  return encode(value, ENCODE_OPTIONS)
}

/** Inverse of {@link packPayload}. A `bin` inside decodes as a view of `bytes`. */
export function unpackPayload(bytes: Uint8Array): unknown {
  return decode(bytes)
}

/** Bytes in the big-endian length prefix that opens every frame. */
const HEADER_BYTES = 4

/**
 * Copy a frame body out of its backing store before decoding when the store
 * holds this many bytes MORE than the frame itself. msgpack `bin` fields
 * decode as VIEWS of the decode input, so one retained field (a state slice,
 * a forwarded log payload) pins the input's WHOLE backing store — with 64 KiB
 * socket read chunks that pinned 55k chunks (3.5 GB off-heap) on hub-main.
 * The exact-fit reassembly path (media frames, `Buffer.concat` sized to the
 * frame) wastes only the 4-byte header and stays zero-extra-copy.
 */
const SLAB_WASTE_MAX_BYTES = 4096

/**
 * Reassembles length-prefixed MsgPack frames from a byte stream.
 *
 * **Why this is a chunk LIST and not a growing Buffer.** The original
 * accumulator did `this.buf = Buffer.concat([this.buf, chunk])` on every
 * socket `data` event. A frame of N bytes delivered in C-byte pieces
 * therefore copied ~N²/2C bytes: a 4 MiB native crop arriving in 64 KiB
 * chunks is ~128 MiB of memcpy plus 64 intermediate Buffer allocations,
 * synchronously, on the thread that also serves every tRPC request. Media
 * transits this router constantly, and hub-main was measured busy 82.2 s out
 * of 120 with 22 uninterrupted blocks ≥1 s.
 *
 * Here the pending chunks are kept as-is and joined ONCE, when a frame is
 * complete — and not even then in the common case, because a frame that
 * arrived whole inside one chunk is sliced out with zero copying. Total work
 * is linear in the bytes received.
 *
 * The wire contract is unchanged: 4-byte big-endian length, then that many
 * MsgPack bytes; a partial frame is buffered; several frames in one chunk are
 * all returned; a frame spanning any number of chunks is reassembled. There
 * is still no upper bound on a declared length — an oversized prefix parks
 * bytes in `chunks` until the peer completes or the socket closes, exactly as
 * before. Bounding it is a transport-protocol change, not a decoder cleanup.
 */
export class FrameDecoder {
  /** Unconsumed bytes, oldest first. `chunks[0]` starts at a frame boundary. */
  private chunks: Buffer[] = []
  /** Sum of `chunks[i].byteLength` — tracked so length checks cost nothing. */
  private buffered = 0
  /** Backing store for {@link lastFrameBytes}; see that getter. */
  private readonly sizes: number[] = []

  /**
   * On-the-wire byte length (4-byte prefix included) of each frame returned by
   * the most recent {@link push}, index-aligned with the returned array.
   *
   * It exists because the frames come back DECODED, and a decoded value has no
   * memory of how many bytes it cost — so a caller counting received bytes per
   * message kind (`SocketChannel`, feeding the `[mem]` line's per-peer socket
   * attribution) could otherwise only charge a whole `data` chunk, which may
   * hold several frames of different kinds, or half of one.
   *
   * **Only the first `frames.length` entries are meaningful**, and the array is
   * never truncated. That is deliberate and it was measured on Node 24.17:
   * `sizes.length = 0` + `push` costs **35.1–35.9 ns** per call — V8 shrinks the
   * backing store and the next call re-grows it — which is 3 % of
   * `FrameDecoder.push` itself and 15× the counter it feeds. Writing in place
   * costs **0.06–0.13 ns**. On a path that runs ~22 000 times a second, an
   * instrument may not be the most expensive thing on the line it measures.
   *
   * Read it immediately after the `push` that produced it — it is a window onto
   * the decoder, not a value. Safe because `push` is only ever driven by a
   * socket `data` event, which Node never delivers re-entrantly.
   */
  get lastFrameBytes(): readonly number[] {
    return this.sizes
  }

  push(chunk: Buffer): unknown[] {
    if (chunk.byteLength > 0) {
      this.chunks.push(chunk)
      this.buffered += chunk.byteLength
    }
    const frames: unknown[] = []
    while (this.buffered >= HEADER_BYTES) {
      const len = this.readLength()
      const total = HEADER_BYTES + len
      if (this.buffered < total) break
      const frame = this.take(total)
      const wasted = frame.buffer.byteLength - frame.byteLength
      let body: Buffer
      if (wasted > SLAB_WASTE_MAX_BYTES) {
        // Unpooled exact-size copy (`allocUnsafeSlow`): a retained decoded
        // field then pins exactly its own bytes — a pooled `Buffer.from`
        // would re-introduce the same class of pinning via the 8 KiB pool.
        body = Buffer.allocUnsafeSlow(len)
        frame.copy(body, 0, HEADER_BYTES)
      } else {
        body = frame.subarray(HEADER_BYTES)
      }
      // Written at the index the frame will occupy, never appended: see
      // `lastFrameBytes` for the ~35 ns that `length = 0` + `push` cost.
      this.sizes[frames.length] = total
      frames.push(decode(body))
    }
    return frames
  }

  /**
   * Read the frame length without consuming it. The prefix itself can land
   * across a chunk boundary (a 3-byte first chunk is a real socket event), so
   * the slow path walks bytes until it has all four.
   */
  private readLength(): number {
    const head = this.chunks[0]
    if (head === undefined) throw new Error('FrameDecoder: buffered bytes with no chunks')
    if (head.byteLength >= HEADER_BYTES) return head.readUInt32BE(0)
    let value = 0
    let seen = 0
    for (const c of this.chunks) {
      for (let i = 0; i < c.byteLength && seen < HEADER_BYTES; i++, seen++) {
        // `c[i]` is in range by construction; the fallback keeps this total.
        value = value * 256 + (c[i] ?? 0)
      }
      if (seen === HEADER_BYTES) break
    }
    return value
  }

  /**
   * Consume and return exactly `n` contiguous bytes.
   *
   * Three cases, cheapest first: the head chunk already holds the whole frame
   * (no copy at all, just a view); the head chunk holds more than the frame
   * (a view plus a rebased head); the frame spans chunks (ONE `Buffer.concat`
   * sized to the frame — the single copy this class is allowed).
   */
  private take(n: number): Buffer {
    const head = this.chunks[0]
    if (head === undefined) throw new Error('FrameDecoder: take() with no chunks')
    this.buffered -= n
    if (head.byteLength === n) {
      this.chunks.shift()
      return head
    }
    if (head.byteLength > n) {
      this.chunks[0] = head.subarray(n)
      return head.subarray(0, n)
    }
    const parts: Buffer[] = []
    let collected = 0
    while (collected < n) {
      const next = this.chunks[0]
      if (next === undefined) throw new Error('FrameDecoder: ran out of chunks mid-frame')
      const remaining = n - collected
      if (next.byteLength <= remaining) {
        parts.push(next)
        collected += next.byteLength
        this.chunks.shift()
        continue
      }
      parts.push(next.subarray(0, remaining))
      this.chunks[0] = next.subarray(remaining)
      collected = n
    }
    return Buffer.concat(parts, n)
  }
}
