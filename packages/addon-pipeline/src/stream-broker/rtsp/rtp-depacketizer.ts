import {
  RTP_HEADER_SIZE,
  H264_NAL_TYPE_MASK,
  H264_NAL_FUA,
  H265_NAL_TYPE_SHIFT,
  H265_NAL_TYPE_MASK,
  H265_NAL_FU,
} from './rtsp-types.js'

// ── Types ───────────────────────────────────────────────────────────

/**
 * Length of the 4-byte Annex-B start code (`00 00 00 01`) every reassembled
 * NAL is built with in front of it. See {@link DepacketizedNal.annexB}.
 */
export const ANNEXB_START_CODE_LENGTH = 4

export interface DepacketizedNal {
  /**
   * Complete NAL unit WITHOUT the start code — a zero-copy view into
   * {@link annexB}, not a separate allocation.
   *
   * Neither this nor `annexB` may be mutated: they share one allocation, and
   * downstream consumers (pre-buffer, pipe server, decoder, restreamers) retain
   * `annexB` for the life of a GOP.
   */
  readonly nal: Buffer
  /**
   * The same NAL with the 4-byte Annex-B start code already in front.
   *
   * Built ONCE here, with the start code reserved as headroom in the same
   * allocation the NAL is reassembled into. This exists so the broker never
   * has to `Buffer.concat([startCode, nal])` — that copied every NAL a second
   * time at full size, on every video NAL of every camera, purely to prepend
   * four constant bytes. Handing back both views costs nothing and removes
   * that copy entirely.
   */
  readonly annexB: Buffer
  /** Whether this NAL is a keyframe (IDR for H.264, IRAP for H.265). */
  readonly keyframe: boolean
  /** Whether this NAL is a parameter set (SPS/PPS/VPS). */
  readonly parameterSet: boolean
  /** RTP timestamp (90kHz clock). */
  readonly timestamp: number
  /** True if the RTP marker bit was set (last packet of access unit). */
  readonly marker: boolean
}

export type NalCallback = (nal: DepacketizedNal) => void

/**
 * What ONE RTP packet carries, read from its payload header alone — before,
 * and independently of, NAL reassembly.
 *
 * `DepacketizedNal.keyframe` is known only when a NAL COMPLETES: for a
 * fragmented IDR that is the last fragment, so every earlier fragment of the
 * same slice looked like a P-frame to a per-packet consumer (the RTSP
 * restreamer's keyframe cache closed its latch on the first FU fragment and
 * re-opened an empty one on the last). This classification reads the NAL type
 * out of the FU header instead, so the first fragment of an IDR is already a
 * keyframe packet.
 */
export interface RtpPacketClass {
  /** RTP timestamp (90 kHz clock). */
  readonly timestamp: number
  /** RTP marker bit — the last packet of an access unit. */
  readonly marker: boolean
  /** The packet carries (a fragment of) an IDR / IRAP slice. */
  readonly keyframe: boolean
  /** The packet carries a parameter set (SPS/PPS, VPS/SPS/PPS). */
  readonly parameterSet: boolean
}

// ── H.264 NAL types ────────────────────────────────────────────────

const H264_NAL_SPS = 7
const H264_NAL_PPS = 8
const H264_NAL_IDR = 5
const H264_NAL_STAP_A = 24

// ── H.265 NAL types ────────────────────────────────────────────────

const H265_NAL_VPS = 32
const H265_NAL_SPS = 33
const H265_NAL_PPS = 34
const H265_NAL_IRAP_MIN = 16
const H265_NAL_IRAP_MAX = 21
const H265_NAL_AP = 48

/**
 * Allocate a NAL buffer of `byteLength` payload bytes with the 4-byte Annex-B
 * start code already written into reserved leading headroom.
 *
 * The caller fills from {@link ANNEXB_START_CODE_LENGTH} onwards. This is the
 * single place a start code is produced on the ingest path — the broker used to
 * build one with `Buffer.from([0, 0, 0, 1])` per NAL and then concat it onto a
 * NAL this function had already allocated, which copied every NAL twice.
 */
function allocAnnexBNal(byteLength: number): Buffer {
  const buf = Buffer.allocUnsafe(ANNEXB_START_CODE_LENGTH + byteLength)
  buf[0] = 0x00
  buf[1] = 0x00
  buf[2] = 0x00
  buf[3] = 0x01
  return buf
}

/** The keyframe / parameter-set content of one RTP payload. */
interface PayloadClass {
  readonly keyframe: boolean
  readonly parameterSet: boolean
}

const NO_PAYLOAD_CLASS: PayloadClass = { keyframe: false, parameterSet: false }

function isH265IrapType(type: number): boolean {
  return type >= H265_NAL_IRAP_MIN && type <= H265_NAL_IRAP_MAX
}

function isH265ParameterSetType(type: number): boolean {
  return type === H265_NAL_VPS || type === H265_NAL_SPS || type === H265_NAL_PPS
}

/** Total byte length of the reassembly fragments, without allocating a closure. */
function totalFragmentBytes(fragments: readonly Buffer[]): number {
  let total = 0
  for (const fragment of fragments) total += fragment.length
  return total
}

// ── Per-packet classification (no reassembly, no allocation) ────────

/** H.264: single NAL by its type; STAP-A by every aggregated type; FU-A by the FU header. */
function classifyH264Payload(payload: Buffer): PayloadClass {
  const nalType = payload[0]! & H264_NAL_TYPE_MASK
  if (nalType === H264_NAL_STAP_A) {
    let keyframe = false
    let parameterSet = false
    let offset = 1
    while (offset + 2 <= payload.length) {
      const nalSize = payload.readUInt16BE(offset)
      offset += 2
      if (nalSize === 0 || offset + nalSize > payload.length) break
      const type = payload[offset]! & H264_NAL_TYPE_MASK
      keyframe ||= type === H264_NAL_IDR
      parameterSet ||= type === H264_NAL_SPS || type === H264_NAL_PPS
      offset += nalSize
    }
    return { keyframe, parameterSet }
  }
  if (nalType === H264_NAL_FUA) {
    if (payload.length < 2) return NO_PAYLOAD_CLASS
    const type = payload[1]! & H264_NAL_TYPE_MASK
    return { keyframe: type === H264_NAL_IDR, parameterSet: false }
  }
  return {
    keyframe: nalType === H264_NAL_IDR,
    parameterSet: nalType === H264_NAL_SPS || nalType === H264_NAL_PPS,
  }
}

/** H.265: single NAL by its type; AP by every aggregated type; FU by the FU header. */
function classifyH265Payload(payload: Buffer): PayloadClass {
  if (payload.length < 2) return NO_PAYLOAD_CLASS
  const nalType = (payload[0]! >> H265_NAL_TYPE_SHIFT) & H265_NAL_TYPE_MASK
  if (nalType === H265_NAL_AP) {
    let keyframe = false
    let parameterSet = false
    let offset = 2
    while (offset + 2 <= payload.length) {
      const nalSize = payload.readUInt16BE(offset)
      offset += 2
      if (nalSize === 0 || offset + nalSize > payload.length) break
      const type = (payload[offset]! >> H265_NAL_TYPE_SHIFT) & H265_NAL_TYPE_MASK
      keyframe ||= isH265IrapType(type)
      parameterSet ||= isH265ParameterSetType(type)
      offset += nalSize
    }
    return { keyframe, parameterSet }
  }
  if (nalType === H265_NAL_FU) {
    if (payload.length < 3) return NO_PAYLOAD_CLASS
    const type = payload[2]! & H265_NAL_TYPE_MASK
    return { keyframe: isH265IrapType(type), parameterSet: false }
  }
  return { keyframe: isH265IrapType(nalType), parameterSet: isH265ParameterSetType(nalType) }
}

/**
 * Classify one raw RTP packet (12-byte header + payload) by what it carries —
 * the per-packet half of {@link RtpDepacketizer.processPacket}, without the
 * reassembly half. Pure: reads the headers, allocates nothing, keeps no state.
 * `null` for a packet too short to be RTP with a payload.
 */
export function classifyRtpPacket(codec: 'h264' | 'h265', rtpData: Buffer): RtpPacketClass | null {
  if (rtpData.length < RTP_HEADER_SIZE) return null
  const marker = (rtpData[1]! & 0x80) !== 0
  const timestamp = rtpData.readUInt32BE(4)
  const payload = rtpData.subarray(RTP_HEADER_SIZE)
  if (payload.length === 0) return null
  const carried = codec === 'h264' ? classifyH264Payload(payload) : classifyH265Payload(payload)
  return { timestamp, marker, keyframe: carried.keyframe, parameterSet: carried.parameterSet }
}

// ── Implementation ──────────────────────────────────────────────────

/**
 * RTP → Annex-B NAL depacketizer.
 *
 * Takes raw RTP packets (as received from TCP interleaved RTSP) and
 * reassembles complete NAL units. Handles:
 *
 * H.264 (RFC 6184):
 *   - Single NAL unit packets (type 1-23)
 *   - STAP-A aggregation packets (type 24)
 *   - FU-A fragmentation packets (type 28)
 *
 * H.265 (RFC 7798):
 *   - Single NAL unit packets (type 0-47, except 48/49)
 *   - AP aggregation packets (type 48)
 *   - FU fragmentation packets (type 49)
 */
export class RtpDepacketizer {
  private readonly codec: 'h264' | 'h265'
  private readonly onNal: NalCallback

  /** FU reassembly state. */
  private fuBuffer: Buffer[] = []
  private fuTimestamp = 0
  /** H.264: stores the reconstructed first byte (NRI + type). */
  private fuFirstByte = 0
  /** H.265: stores the 2-byte NAL header from the FU payload header. */
  private fuH265Header: Buffer | null = null

  constructor(codec: 'h264' | 'h265', onNal: NalCallback) {
    this.codec = codec
    this.onNal = onNal
  }

  /** Reset reassembly state (e.g. on stream restart). */
  reset(): void {
    this.fuBuffer = []
    this.fuTimestamp = 0

    this.fuFirstByte = 0
    this.fuH265Header = null
  }

  /**
   * Process a raw RTP packet (including 12-byte RTP header).
   * Emits zero or more complete NAL units via the callback and returns what
   * THIS packet carried ({@link RtpPacketClass}) — `null` for a packet too
   * short to be RTP with a payload.
   */
  processPacket(rtpData: Buffer): RtpPacketClass | null {
    const carried = this.classifyPacket(rtpData)
    if (carried === null) return null

    const payload = rtpData.subarray(RTP_HEADER_SIZE)
    if (this.codec === 'h264') {
      this.processH264(payload, carried.timestamp, carried.marker)
    } else {
      this.processH265(payload, carried.timestamp, carried.marker)
    }
    return carried
  }

  /**
   * What this packet CARRIES, and nothing else: no NAL is reassembled, no buffer
   * allocated, no reassembly state touched. The same verdict `processPacket`
   * returns, for a broker whose Annex-B plane has no consumer — the source-RTP
   * ring, the restreamer's keyframe cache and the stats need exactly this and
   * none of the copies.
   */
  classifyPacket(rtpData: Buffer): RtpPacketClass | null {
    return classifyRtpPacket(this.codec, rtpData)
  }

  // ── H.264 ─────────────────────────────────────────────────────────

  private processH264(payload: Buffer, timestamp: number, marker: boolean): void {
    const firstByte = payload[0]!
    const nalType = firstByte & H264_NAL_TYPE_MASK

    if (nalType >= 1 && nalType <= 23) {
      // Single NAL unit packet. Copied rather than passed as a view: `payload`
      // aliases the reader's socket buffer, which is advanced on the next read,
      // and downstream retains this NAL for the life of a GOP.
      this.emitNal(this.copyIntoAnnexB(payload), timestamp, marker)
    } else if (nalType === H264_NAL_STAP_A) {
      this.processH264StapA(payload, timestamp, marker)
    } else if (nalType === H264_NAL_FUA) {
      this.processH264FuA(payload, timestamp, marker)
    }
    // Types 25-27 (STAP-B, MTAP16, MTAP24) and 29 (FU-B) are extremely rare
    // in IP camera streams — ignore them.
  }

  /** STAP-A: Single-Time Aggregation Packet (multiple NALs in one RTP). */
  private processH264StapA(payload: Buffer, timestamp: number, marker: boolean): void {
    let offset = 1 // Skip STAP-A header byte
    while (offset + 2 <= payload.length) {
      const nalSize = payload.readUInt16BE(offset)
      offset += 2
      if (offset + nalSize > payload.length) break

      const nal = allocAnnexBNal(nalSize)
      payload.copy(nal, ANNEXB_START_CODE_LENGTH, offset, offset + nalSize)
      offset += nalSize
      this.emitNal(nal, timestamp, marker && offset >= payload.length)
    }
  }

  /** FU-A: Fragmentation Unit (large NAL split across multiple RTP packets). */
  private processH264FuA(payload: Buffer, timestamp: number, marker: boolean): void {
    if (payload.length < 2) return

    const fuIndicator = payload[0]!
    const fuHeader = payload[1]!
    const isStart = (fuHeader & 0x80) !== 0
    const isEnd = (fuHeader & 0x40) !== 0
    const nalType = fuHeader & H264_NAL_TYPE_MASK

    if (isStart) {
      // Start fragment — reconstruct NAL first byte: NRI from indicator + type from header
      this.fuBuffer = [payload.subarray(2)]
      this.fuTimestamp = timestamp

      this.fuFirstByte = (fuIndicator & 0xe0) | nalType
    } else if (this.fuBuffer.length > 0 && this.fuTimestamp === timestamp) {
      // Middle or end fragment
      this.fuBuffer.push(payload.subarray(2))

      if (isEnd) {
        // Reassemble: prepend reconstructed NAL header byte
        const totalSize = totalFragmentBytes(this.fuBuffer)
        const nal = allocAnnexBNal(1 + totalSize)
        nal[ANNEXB_START_CODE_LENGTH] = this.fuFirstByte
        let offset = ANNEXB_START_CODE_LENGTH + 1
        for (const fragment of this.fuBuffer) {
          fragment.copy(nal, offset)
          offset += fragment.length
        }
        this.fuBuffer = []
        this.emitNal(nal, timestamp, marker)
      }
    } else {
      // Out-of-order or gap — discard partial reassembly
      this.fuBuffer = []
    }
  }

  // ── H.265 ─────────────────────────────────────────────────────────

  private processH265(payload: Buffer, timestamp: number, marker: boolean): void {
    if (payload.length < 2) return

    const nalType = (payload[0]! >> H265_NAL_TYPE_SHIFT) & H265_NAL_TYPE_MASK

    if (nalType < 48) {
      // Single NAL unit packet (types 0-47). Copied — see the H.264 twin.
      this.emitNal(this.copyIntoAnnexB(payload), timestamp, marker)
    } else if (nalType === H265_NAL_AP) {
      this.processH265Ap(payload, timestamp, marker)
    } else if (nalType === H265_NAL_FU) {
      this.processH265Fu(payload, timestamp, marker)
    }
  }

  /** AP: Aggregation Packet (multiple NALs in one RTP). */
  private processH265Ap(payload: Buffer, timestamp: number, marker: boolean): void {
    let offset = 2 // Skip 2-byte AP payload header
    while (offset + 2 <= payload.length) {
      const nalSize = payload.readUInt16BE(offset)
      offset += 2
      if (offset + nalSize > payload.length) break

      const nal = allocAnnexBNal(nalSize)
      payload.copy(nal, ANNEXB_START_CODE_LENGTH, offset, offset + nalSize)
      offset += nalSize
      this.emitNal(nal, timestamp, marker && offset >= payload.length)
    }
  }

  /** FU: Fragmentation Unit (large NAL split across multiple RTP packets). */
  private processH265Fu(payload: Buffer, timestamp: number, marker: boolean): void {
    if (payload.length < 3) return

    const fuHeader = payload[2]!
    const isStart = (fuHeader & 0x80) !== 0
    const isEnd = (fuHeader & 0x40) !== 0
    const nalType = fuHeader & H265_NAL_TYPE_MASK

    if (isStart) {
      // Start fragment — store payload header bytes for NAL header reconstruction
      this.fuBuffer = [payload.subarray(3)]
      this.fuTimestamp = timestamp

      // Reconstruct 2-byte NAL header: replace FU type with actual NAL type
      const header = Buffer.allocUnsafe(2)
      header[0] = (payload[0]! & 0x81) | (nalType << H265_NAL_TYPE_SHIFT)
      header[1] = payload[1]!
      this.fuH265Header = header
    } else if (this.fuBuffer.length > 0 && this.fuTimestamp === timestamp) {
      // Middle or end fragment
      this.fuBuffer.push(payload.subarray(3))

      if (isEnd && this.fuH265Header) {
        // Reassemble: prepend 2-byte NAL header
        const totalSize = totalFragmentBytes(this.fuBuffer)
        const nal = allocAnnexBNal(2 + totalSize)
        this.fuH265Header.copy(nal, ANNEXB_START_CODE_LENGTH)
        let offset = ANNEXB_START_CODE_LENGTH + 2
        for (const fragment of this.fuBuffer) {
          fragment.copy(nal, offset)
          offset += fragment.length
        }
        this.fuBuffer = []
        this.fuH265Header = null
        this.emitNal(nal, timestamp, marker)
      }
    } else {
      // Gap — discard
      this.fuBuffer = []
      this.fuH265Header = null
    }
  }

  // ── Emit ──────────────────────────────────────────────────────────

  /** Copy a payload view into a fresh Annex-B buffer (start code + payload). */
  private copyIntoAnnexB(payload: Buffer): Buffer {
    const buf = allocAnnexBNal(payload.length)
    payload.copy(buf, ANNEXB_START_CODE_LENGTH)
    return buf
  }

  /**
   * @param annexB the NAL WITH its 4-byte start code already in front — every
   * caller builds it that way via {@link allocAnnexBNal}, so `nal` below is a
   * free view rather than a second allocation.
   */
  private emitNal(annexB: Buffer, timestamp: number, marker: boolean): void {
    const nal = annexB.subarray(ANNEXB_START_CODE_LENGTH)
    const keyframe = this.codec === 'h264' ? this.isH264Keyframe(nal) : this.isH265Keyframe(nal)

    const parameterSet =
      this.codec === 'h264' ? this.isH264ParameterSet(nal) : this.isH265ParameterSet(nal)

    this.onNal({ nal, annexB, keyframe, parameterSet, timestamp, marker })
  }

  private isH264Keyframe(nal: Buffer): boolean {
    if (nal.length === 0) return false
    return (nal[0]! & H264_NAL_TYPE_MASK) === H264_NAL_IDR
  }

  private isH264ParameterSet(nal: Buffer): boolean {
    if (nal.length === 0) return false
    const type = nal[0]! & H264_NAL_TYPE_MASK
    return type === H264_NAL_SPS || type === H264_NAL_PPS
  }

  private isH265Keyframe(nal: Buffer): boolean {
    if (nal.length < 2) return false
    const type = (nal[0]! >> H265_NAL_TYPE_SHIFT) & H265_NAL_TYPE_MASK
    return type >= H265_NAL_IRAP_MIN && type <= H265_NAL_IRAP_MAX
  }

  private isH265ParameterSet(nal: Buffer): boolean {
    if (nal.length < 2) return false
    const type = (nal[0]! >> H265_NAL_TYPE_SHIFT) & H265_NAL_TYPE_MASK
    return type === H265_NAL_VPS || type === H265_NAL_SPS || type === H265_NAL_PPS
  }
}
