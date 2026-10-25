import {
  RTP_VERSION,
  RTP_HEADER_SIZE,
  RTP_MAX_PAYLOAD,
  H264_NAL_TYPE_MASK,
  H264_NAL_FUA,
  H265_NAL_TYPE_SHIFT,
  H265_NAL_TYPE_MASK,
  H265_NAL_FU,
  type RtpPacket,
} from './rtsp-types.js'

export class RtpPacketizer {
  private sequenceNumber = 0
  private readonly ssrc: number

  constructor(
    private readonly codec: 'h264' | 'h265',
    private readonly payloadType: number,
  ) {
    this.ssrc = Math.floor(Math.random() * 0xffffffff)
  }

  /**
   * Split Annex-B byte stream into individual NAL units.
   * Strips 3-byte (0x000001) and 4-byte (0x00000001) start codes.
   */
  static splitAnnexB(data: Buffer): ReadonlyArray<Buffer> {
    const nals: Buffer[] = []
    let start = -1

    for (let i = 0; i < data.length - 2; i++) {
      const isStartCode3 = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1
      const isStartCode4 =
        i + 3 < data.length &&
        data[i] === 0 &&
        data[i + 1] === 0 &&
        data[i + 2] === 0 &&
        data[i + 3] === 1

      if (isStartCode3 || isStartCode4) {
        if (start >= 0) {
          // Strip trailing zero bytes — they belong to the next start code prefix.
          // Emulation prevention (00 00 03) guarantees no false start codes in NAL payload.
          let end = i
          while (end > start && data[end - 1] === 0) end--
          if (end > start) nals.push(data.subarray(start, end))
        }
        start = isStartCode4 ? i + 4 : i + 3
        if (isStartCode4) i += 3
        else i += 2
      }
    }

    if (start >= 0 && start < data.length) {
      nals.push(data.subarray(start))
    }

    return nals
  }

  /**
   * Packetize a single NAL unit into one or more RTP packets.
   * @param nal NAL unit WITHOUT start code
   * @param timestamp RTP timestamp (90kHz clock)
   * @param marker true if this is the last NAL of the access unit
   */
  packetize(nal: Buffer, timestamp: number, marker: boolean): ReadonlyArray<RtpPacket> {
    if (this.codec === 'h264') {
      return this.packetizeH264(nal, timestamp, marker)
    }
    return this.packetizeH265(nal, timestamp, marker)
  }

  private packetizeH264(nal: Buffer, timestamp: number, marker: boolean): ReadonlyArray<RtpPacket> {
    if (nal.length <= RTP_MAX_PAYLOAD) {
      return [this.buildRtpPacket(nal, timestamp, marker)]
    }
    return this.fragmentH264FUA(nal, timestamp, marker)
  }

  private packetizeH265(nal: Buffer, timestamp: number, marker: boolean): ReadonlyArray<RtpPacket> {
    if (nal.length <= RTP_MAX_PAYLOAD) {
      return [this.buildRtpPacket(nal, timestamp, marker)]
    }
    return this.fragmentH265FU(nal, timestamp, marker)
  }

  /** H.264 FU-A fragmentation (RFC 6184 Section 5.8). */
  private fragmentH264FUA(
    nal: Buffer,
    timestamp: number,
    marker: boolean,
  ): ReadonlyArray<RtpPacket> {
    const nalHeader = nal[0]!
    const fnri = nalHeader & 0xe0
    const nalType = nalHeader & H264_NAL_TYPE_MASK
    const payload = nal.subarray(1)

    const maxFragment = RTP_MAX_PAYLOAD - 2
    const packets: RtpPacket[] = []
    let offset = 0

    while (offset < payload.length) {
      const end = Math.min(offset + maxFragment, payload.length)
      const isFirst = offset === 0
      const isLast = end === payload.length

      const fuIndicator = fnri | H264_NAL_FUA
      const fuHeader = (isFirst ? 0x80 : 0) | (isLast ? 0x40 : 0) | nalType

      const fragment = Buffer.allocUnsafe(2 + (end - offset))
      fragment[0] = fuIndicator
      fragment[1] = fuHeader
      payload.copy(fragment, 2, offset, end)

      packets.push(this.buildRtpPacket(fragment, timestamp, isLast && marker))
      offset = end
    }

    return packets
  }

  /** H.265 FU fragmentation (RFC 7798 Section 4.4.3). */
  private fragmentH265FU(
    nal: Buffer,
    timestamp: number,
    marker: boolean,
  ): ReadonlyArray<RtpPacket> {
    const nalType = (nal[0]! >> H265_NAL_TYPE_SHIFT) & H265_NAL_TYPE_MASK
    const tidLayerId = nal[1]!
    const payload = nal.subarray(2)

    const maxFragment = RTP_MAX_PAYLOAD - 3
    const packets: RtpPacket[] = []
    let offset = 0

    while (offset < payload.length) {
      const end = Math.min(offset + maxFragment, payload.length)
      const isFirst = offset === 0
      const isLast = end === payload.length

      const payloadHdr0 = (H265_NAL_FU << H265_NAL_TYPE_SHIFT) | (nal[0]! & 0x81)
      const payloadHdr1 = tidLayerId
      const fuHeader = (isFirst ? 0x80 : 0) | (isLast ? 0x40 : 0) | nalType

      const fragment = Buffer.allocUnsafe(3 + (end - offset))
      fragment[0] = payloadHdr0
      fragment[1] = payloadHdr1
      fragment[2] = fuHeader
      payload.copy(fragment, 3, offset, end)

      packets.push(this.buildRtpPacket(fragment, timestamp, isLast && marker))
      offset = end
    }

    return packets
  }

  private buildRtpPacket(payload: Buffer, timestamp: number, marker: boolean): RtpPacket {
    const header = Buffer.allocUnsafe(RTP_HEADER_SIZE)
    header[0] = RTP_VERSION << 6
    header[1] = (marker ? 0x80 : 0) | (this.payloadType & 0x7f)
    header.writeUInt16BE(this.sequenceNumber & 0xffff, 2)
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff
    header.writeUInt32BE(timestamp >>> 0, 4)
    header.writeUInt32BE(this.ssrc >>> 0, 8)

    return {
      data: Buffer.concat([header, payload]),
      marker,
    }
  }
}
