/**
 * Does this RTP packet carry the start of a key frame?
 *
 * A pass-through session cannot manufacture a key frame on demand — it can
 * only forward the one the camera decides to emit. So the number that decides
 * whether a controller sees a picture or a loader is *how long it waited for
 * the first IDR*, and until now nothing measured it: a session could report
 * a thousand packets forwarded, zero loss, and a blank screen, with no field
 * distinguishing "the stream is broken" from "the next key frame is 20
 * seconds away".
 *
 * That is the whole reason this exists, so it is deliberately narrow: a
 * boolean per packet, no state, no allocation, and it never throws. It runs on
 * every forwarded video packet, and a parser that throws on a malformed packet
 * would take the media path down with it.
 *
 * ## Two codecs, two headers
 *
 * H.264 (RFC 6184) has a ONE-byte NAL header whose type is the low 5 bits.
 * HEVC (RFC 7798) has a TWO-byte header whose type is bits 1..6 of the first.
 * The H.264 parser applied to an HEVC packet reads a type that means nothing
 * and answers "no key frame" forever — which, since this is telemetry and not
 * a gate, would show an HEVC session streaming perfectly with `videoKeyframes`
 * stuck at zero. That is the exact shape of the bug these counters exist to
 * detect (D515), so the codec is a parameter rather than an assumption.
 */

/** NAL unit type carrying a coded slice of an IDR picture (RFC 6184 §5.2). */
const NAL_TYPE_IDR = 5
/** Single-time aggregation packet — several NALs in one RTP payload. */
const NAL_TYPE_STAP_A = 24
/** Fragmentation units: one NAL spread over several RTP payloads. */
const NAL_TYPE_FU_A = 28
const NAL_TYPE_FU_B = 29

const RTP_MIN_HEADER_BYTES = 12
const NAL_TYPE_MASK = 0x1f
/** FU header start bit — set only on the FIRST fragment of a fragmented NAL. */
const FU_START_BIT = 0x80

/** The codecs this detector knows how to read. */
export type KeyframeCodec = 'h264' | 'h265'

/** HEVC NAL types 16..23 are IRAP pictures — the key frames of HEVC. */
const HEVC_IRAP_MIN = 16
const HEVC_IRAP_MAX = 23
/** RFC 7798 payload structures: 48 aggregation, 49 fragmentation unit. */
const HEVC_TYPE_AP = 48
const HEVC_TYPE_FU = 49
const HEVC_TYPE_MASK = 0x3f

export function rtpPacketCarriesKeyframe(packet: Buffer, codec: KeyframeCodec): boolean {
  return codec === 'h265' ? rtpPacketCarriesIrap(packet) : rtpPacketCarriesIdr(packet)
}

export function rtpPacketCarriesIdr(packet: Buffer): boolean {
  const payloadStart = rtpPayloadOffset(packet)
  if (payloadStart === null) return false

  const firstPayloadByte = packet[payloadStart]
  if (firstPayloadByte === undefined) return false
  const nalType = firstPayloadByte & NAL_TYPE_MASK

  if (nalType === NAL_TYPE_FU_A || nalType === NAL_TYPE_FU_B) {
    // Only the start fragment counts. A 720p IDR spans dozens of fragments,
    // and counting each would report one key frame per packet.
    const fuHeader = packet[payloadStart + 1]
    if (fuHeader === undefined) return false
    if ((fuHeader & FU_START_BIT) === 0) return false
    return (fuHeader & NAL_TYPE_MASK) === NAL_TYPE_IDR
  }

  if (nalType === NAL_TYPE_STAP_A) {
    return stapContainsIdr(packet, payloadStart + 1)
  }

  return nalType === NAL_TYPE_IDR
}

/**
 * Byte offset of the RTP payload, or `null` when the packet is too short to
 * hold one. The variable-length parts are what make this worth a function:
 * a fixed offset of 12 is right for every packet ffmpeg emits today and wrong
 * the moment one carries a CSRC list or a header extension.
 */
function rtpPayloadOffset(packet: Buffer): number | null {
  if (packet.length <= RTP_MIN_HEADER_BYTES) return null

  const flags = packet[0]
  if (flags === undefined) return null
  const csrcCount = flags & 0x0f
  const hasExtension = (flags & 0x10) !== 0
  let offset = RTP_MIN_HEADER_BYTES + csrcCount * 4

  if (hasExtension) {
    // profile (2 bytes) + length in 32-bit words (2 bytes) + the words.
    if (offset + 4 > packet.length) return null
    const words = packet.readUInt16BE(offset + 2)
    offset += 4 + words * 4
  }

  return offset < packet.length ? offset : null
}

/** Walk a STAP-A's `[size][nal]` pairs looking for an IDR. */
function stapContainsIdr(packet: Buffer, start: number): boolean {
  let offset = start
  while (offset + 2 <= packet.length) {
    const size = packet.readUInt16BE(offset)
    offset += 2
    // A size running past the end means a malformed or truncated packet;
    // stop rather than read outside it.
    if (size === 0 || offset + size > packet.length) return false
    const nalHeader = packet[offset]
    if (nalHeader === undefined) return false
    if ((nalHeader & NAL_TYPE_MASK) === NAL_TYPE_IDR) return true
    offset += size
  }
  return false
}

/** HEVC's half: the same shape, read through RFC 7798's two-byte header. */
function rtpPacketCarriesIrap(packet: Buffer): boolean {
  const payloadStart = rtpPayloadOffset(packet)
  if (payloadStart === null) return false

  const firstPayloadByte = packet[payloadStart]
  if (firstPayloadByte === undefined) return false
  const nalType = (firstPayloadByte >> 1) & HEVC_TYPE_MASK

  if (nalType === HEVC_TYPE_FU) {
    // Header is two bytes, then the FU header; only the START fragment counts.
    const fuHeader = packet[payloadStart + 2]
    if (fuHeader === undefined) return false
    if ((fuHeader & FU_START_BIT) === 0) return false
    return isHevcIrap(fuHeader & HEVC_TYPE_MASK)
  }

  if (nalType === HEVC_TYPE_AP) {
    return hevcAggregationContainsIrap(packet, payloadStart + 2)
  }

  return isHevcIrap(nalType)
}

function isHevcIrap(nalType: number): boolean {
  return nalType >= HEVC_IRAP_MIN && nalType <= HEVC_IRAP_MAX
}

/** Walk an aggregation packet's `[size][nal]` pairs looking for an IRAP. */
function hevcAggregationContainsIrap(packet: Buffer, start: number): boolean {
  let offset = start
  while (offset + 2 <= packet.length) {
    const size = packet.readUInt16BE(offset)
    offset += 2
    // A size running past the end means a malformed or truncated packet;
    // stop rather than read outside it.
    if (size === 0 || offset + size > packet.length) return false
    const nalHeader = packet[offset]
    if (nalHeader === undefined) return false
    if (isHevcIrap((nalHeader >> 1) & HEVC_TYPE_MASK)) return true
    offset += size
  }
  return false
}
