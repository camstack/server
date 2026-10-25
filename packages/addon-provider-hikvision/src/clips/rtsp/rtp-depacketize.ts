/**
 * RTP → elementary stream, for the two things a Hikvision replay carries.
 *
 * Pure and incremental. Every decision is made from the packet in hand plus
 * the accumulator; nothing reads a clock, a socket or a logger, so the whole
 * module is provable against the bytes of a real replay captured off the wire.
 *
 * ## What the video side produces
 *
 * Annex-B access units: `00 00 00 01` before every NAL, the parameter sets
 * prepended to the first one, ready for `ffmpeg -f hevc -i pipe:0`. That is
 * the SAME contract the Reolink clip path feeds its mux (D567/D600), reached
 * from a different wire.
 *
 * ## Where an access unit ENDS
 *
 * On the RTP timestamp CHANGING, not on the marker bit. Both are present on
 * this firmware, and the timestamp is the one that cannot lie: a marker bit is
 * the sender's opinion about the last packet of a frame and a lost packet
 * takes it with it, whereas a timestamp that moved is the next frame by
 * definition. The cost is that the final access unit is closed by the END of
 * the stream rather than by a packet — {@link RtpVideoDepacketizer.flush} — and
 * a producer that forgets to flush loses exactly one frame.
 *
 * ## What is DROPPED, and why it is counted
 *
 * A fragment whose start was never seen (the session joined mid-NAL, a packet
 * was lost) cannot produce a NAL, and neither can a payload shorter than its
 * own header. Both are dropped, and both are COUNTED: a branch that discards
 * media silently reads as "the camera sent nothing", which is the failure this
 * repo has paid for twice.
 */

/** RTP fixed header, before any CSRC or extension. */
const RTP_HEADER_BYTES = 12

export interface RtpPacket {
  readonly payloadType: number
  readonly sequence: number
  readonly timestamp: number
  readonly marker: boolean
  readonly payload: Buffer
}

/**
 * Parse one RTP packet. `null` for anything that is not one — an RTCP report
 * on the odd channel, a truncated packet, a version this is not.
 */
export function parseRtpPacket(packet: Buffer): RtpPacket | null {
  if (packet.byteLength < RTP_HEADER_BYTES) return null
  const first = packet[0] ?? 0
  if (first >> 6 !== 2) return null
  const csrcCount = first & 0x0f
  const second = packet[1] ?? 0
  let offset = RTP_HEADER_BYTES + csrcCount * 4
  if (packet.byteLength < offset) return null
  if ((first & 0x10) !== 0) {
    // One header extension: 2 bytes of profile, 2 bytes of length in words.
    if (packet.byteLength < offset + 4) return null
    offset += 4 + packet.readUInt16BE(offset + 2) * 4
    if (packet.byteLength < offset) return null
  }
  let end = packet.byteLength
  if ((first & 0x20) !== 0) {
    // Padding: the last byte counts the padding bytes, itself included.
    const padding = packet[end - 1] ?? 0
    if (padding === 0 || padding > end - offset) return null
    end -= padding
  }
  if (end < offset) return null
  return {
    payloadType: second & 0x7f,
    sequence: packet.readUInt16BE(2),
    timestamp: packet.readUInt32BE(4),
    marker: (second & 0x80) !== 0,
    payload: packet.subarray(offset, end),
  }
}

export interface VideoAccessUnit {
  /** Annex-B bytes, parameter sets included on the first unit. */
  readonly bytes: Buffer
  /** The RTP timestamp every packet of this unit carried. */
  readonly timestamp: number
  /** This unit opens with a NAL a decoder can start from. */
  readonly keyframe: boolean
}

export interface RtpVideoDepacketizer {
  /** Feed one parsed RTP packet; get the access unit it CLOSED, if any. */
  push(packet: RtpPacket): VideoAccessUnit | null
  /** Close the last unit at end of stream. */
  flush(): VideoAccessUnit | null
  /** Payloads this depacketizer could not turn into a NAL. */
  readonly dropped: number
}

const START_CODE = Buffer.from([0, 0, 0, 1])

function annexB(nals: readonly Buffer[]): Buffer {
  const parts: Buffer[] = []
  for (const nal of nals) {
    parts.push(START_CODE, nal)
  }
  return Buffer.concat(parts)
}

/** H.265 NAL types a decoder may begin at (BLA/IDR/CRA — 16…21). */
function h265IsKeyframe(nalType: number): boolean {
  return nalType >= 16 && nalType <= 21
}

/** H.265 NAL types that are parameter sets — VPS/SPS/PPS. */
function h265IsParameterSet(nalType: number): boolean {
  return nalType === 32 || nalType === 33 || nalType === 34
}

export interface VideoDepacketizerOptions {
  readonly codec: 'h264' | 'h265'
  /** Decoded `sprop-*` NALs, prepended to the first access unit. */
  readonly parameterSets: readonly Buffer[]
}

export function createRtpVideoDepacketizer(
  options: VideoDepacketizerOptions,
): RtpVideoDepacketizer {
  const isH265 = options.codec === 'h265'
  let pendingNals: Buffer[] = []
  let pendingTimestamp: number | null = null
  let pendingKeyframe = false
  /** A fragment being reassembled across packets (FU / FU-A). */
  let fragment: Buffer[] | null = null
  let dropped = 0
  let sentParameterSets = false

  const nalTypeOf = (nal: Buffer): number =>
    isH265 ? ((nal[0] ?? 0) >> 1) & 0x3f : (nal[0] ?? 0) & 0x1f

  const isKeyframe = (nal: Buffer): boolean => {
    const type = nalTypeOf(nal)
    return isH265 ? h265IsKeyframe(type) : type === 5
  }

  const isParameterSet = (nal: Buffer): boolean => {
    const type = nalTypeOf(nal)
    return isH265 ? h265IsParameterSet(type) : type === 7 || type === 8
  }

  const close = (): VideoAccessUnit | null => {
    if (pendingNals.length === 0 || pendingTimestamp === null) {
      pendingNals = []
      pendingTimestamp = null
      pendingKeyframe = false
      return null
    }
    const nals = [...pendingNals]
    // The parameter sets, once, in front of the first unit that carries a
    // picture. A camera that already repeated them in-band is left alone: two
    // copies are legal but they are noise in a fixture and in a log.
    if (!sentParameterSets && options.parameterSets.length > 0) {
      const alreadyHas = nals.some((nal) => isParameterSet(nal))
      if (!alreadyHas) nals.unshift(...options.parameterSets)
      sentParameterSets = true
    }
    const unit: VideoAccessUnit = {
      bytes: annexB(nals),
      timestamp: pendingTimestamp,
      keyframe: pendingKeyframe,
    }
    pendingNals = []
    pendingTimestamp = null
    pendingKeyframe = false
    return unit
  }

  const addNal = (nal: Buffer, timestamp: number): void => {
    pendingNals.push(nal)
    pendingTimestamp = timestamp
    if (isKeyframe(nal)) pendingKeyframe = true
  }

  const pushH265 = (packet: RtpPacket): void => {
    const payload = packet.payload
    if (payload.byteLength < 2) {
      dropped += 1
      return
    }
    const type = ((payload[0] ?? 0) >> 1) & 0x3f
    if (type === 48) {
      // Aggregation packet: 2-byte PayloadHdr, then [u16 size][NAL]…
      let offset = 2
      while (offset + 2 <= payload.byteLength) {
        const size = payload.readUInt16BE(offset)
        offset += 2
        if (size === 0 || offset + size > payload.byteLength) {
          dropped += 1
          return
        }
        addNal(Buffer.from(payload.subarray(offset, offset + size)), packet.timestamp)
        offset += size
      }
      return
    }
    if (type === 49) {
      // Fragmentation unit: PayloadHdr(2) + FU header(1).
      if (payload.byteLength < 3) {
        dropped += 1
        return
      }
      const fu = payload[2] ?? 0
      const start = (fu & 0x80) !== 0
      const end = (fu & 0x40) !== 0
      const fuType = fu & 0x3f
      if (start) {
        const header = Buffer.from([((payload[0] ?? 0) & 0x81) | (fuType << 1), payload[1] ?? 0])
        fragment = [header, Buffer.from(payload.subarray(3))]
      } else {
        if (fragment === null) {
          // The start was never seen. There is no NAL to be had.
          dropped += 1
          return
        }
        fragment.push(Buffer.from(payload.subarray(3)))
      }
      if (end && fragment !== null) {
        addNal(Buffer.concat(fragment), packet.timestamp)
        fragment = null
      }
      return
    }
    addNal(Buffer.from(payload), packet.timestamp)
  }

  const pushH264 = (packet: RtpPacket): void => {
    const payload = packet.payload
    if (payload.byteLength < 1) {
      dropped += 1
      return
    }
    const type = (payload[0] ?? 0) & 0x1f
    if (type === 24) {
      // STAP-A: 1-byte header, then [u16 size][NAL]…
      let offset = 1
      while (offset + 2 <= payload.byteLength) {
        const size = payload.readUInt16BE(offset)
        offset += 2
        if (size === 0 || offset + size > payload.byteLength) {
          dropped += 1
          return
        }
        addNal(Buffer.from(payload.subarray(offset, offset + size)), packet.timestamp)
        offset += size
      }
      return
    }
    if (type === 28) {
      if (payload.byteLength < 2) {
        dropped += 1
        return
      }
      const fu = payload[1] ?? 0
      const start = (fu & 0x80) !== 0
      const end = (fu & 0x40) !== 0
      if (start) {
        const header = Buffer.from([((payload[0] ?? 0) & 0xe0) | (fu & 0x1f)])
        fragment = [header, Buffer.from(payload.subarray(2))]
      } else {
        if (fragment === null) {
          dropped += 1
          return
        }
        fragment.push(Buffer.from(payload.subarray(2)))
      }
      if (end && fragment !== null) {
        addNal(Buffer.concat(fragment), packet.timestamp)
        fragment = null
      }
      return
    }
    addNal(Buffer.from(payload), packet.timestamp)
  }

  return {
    get dropped() {
      return dropped
    },
    push(packet) {
      // The unit boundary: a timestamp that MOVED closes what came before it.
      const closed =
        pendingTimestamp !== null && packet.timestamp !== pendingTimestamp ? close() : null
      if (isH265) pushH265(packet)
      else pushH264(packet)
      return closed
    },
    flush() {
      if (fragment !== null) {
        // A fragment the stream ended inside is not a NAL, and half a NAL in
        // front of the decoder is worse than one frame short.
        dropped += 1
        fragment = null
      }
      return close()
    },
  }
}

/**
 * µ-law audio: the RTP payload IS the elementary stream.
 *
 * G.711 is a byte per sample with no framing of its own, so there is nothing
 * to depacketize — what matters is that a caller writes the payloads in
 * arrival order and counts them, which is what makes "this recording had no
 * sound" distinguishable from "we dropped it".
 */
export function pcmuPayloadOf(packet: RtpPacket): Buffer {
  return packet.payload
}
