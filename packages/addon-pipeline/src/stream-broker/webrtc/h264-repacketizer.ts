/**
 * Re-fragments H.264 RTP packets coming straight off the camera so they
 * fit the WebRTC peer's MTU (~1200 bytes) WITHOUT re-encoding or rebuilding
 * the RTP header from scratch. Source SSRC/seq/timestamp are preserved
 * (only adjusted by werift's `replaceRTP` offset machinery on send), and
 * SPS/PPS are aggregated into a STAP-A sent before every IDR.
 *
 * This is the H.264 sibling of `H265Repacketizer`. Forwarding source RTP
 * through it — instead of the "depacketize → Annex-B → re-packetize from
 * scratch" `writeVideoNals` path — is what makes Main/High passthrough
 * decodable on iOS (WebKit), whose H.264 depacketizer is as strict as its
 * HEVC one. Desktop Chrome tolerates the synthesized shape; iOS does not.
 */
import { isNextSequenceNumber, JitterBuffer, RtpPacket } from './jitter-buffer.js'
import { OutputArena } from './output-arena.js'

// https://yumichan.net/video-processing/video-compression/introduction-to-h264-nal-unit/
export const NAL_TYPE_STAP_A = 24
export const NAL_TYPE_FU_A = 28
export const NAL_TYPE_NON_IDR = 1
export const NAL_TYPE_IDR = 5
export const NAL_TYPE_SEI = 6
export const NAL_TYPE_SPS = 7
export const NAL_TYPE_PPS = 8
export const NAL_TYPE_DELIMITER = 9

const NAL_HEADER_SIZE = 1
const FU_A_HEADER_SIZE = 2
const LENGTH_FIELD_SIZE = 2
const STAP_A_HEADER_SIZE = NAL_HEADER_SIZE + LENGTH_FIELD_SIZE

// A STAP-A packet aggregates multiple NALs. Split it back into them.
export function depacketizeStapA(data: Buffer): Buffer[] {
  const ret: Buffer[] = []
  let lastPos: number | undefined
  let pos = NAL_HEADER_SIZE
  while (pos < data.length) {
    if (lastPos !== undefined) ret.push(data.subarray(lastPos, pos))
    const naluSize = data.readUInt16BE(pos)
    pos += LENGTH_FIELD_SIZE
    lastPos = pos
    pos += naluSize
  }
  ret.push(data.subarray(lastPos))
  return ret
}

export function splitH264NaluStartCode(data: Buffer): Buffer[] {
  const ret: Buffer[] = []
  let previous = 0
  let offset = 0
  const maybeAddSlice = (): void => {
    const slice = data.subarray(previous, offset)
    if (slice.length) ret.push(slice)
    offset += 4
    previous = offset
  }

  while (offset < data.length - 4) {
    const startCode = data.readUInt32BE(offset)
    if (startCode === 1) {
      maybeAddSlice()
    } else {
      offset++
    }
  }
  offset = data.length
  maybeAddSlice()

  return ret
}

export interface H264CodecInfo {
  sps?: Buffer
  pps?: Buffer
  // SEI may only apply to a number/time range of frames; resending it with
  // every keyframe is a best-effort to keep decoders that need the SEI in sync.
  sei?: Buffer
}

interface FuaFragmentOptions {
  payload: Buffer
  noStart: boolean
  noEnd: boolean
  marker: boolean
}

export class H264Repacketizer {
  extraPackets = 0
  fuaMax!: number
  pendingFuA: RtpPacket[] | undefined
  // the stapa packet that will be sent before an idr frame.
  stapa: RtpPacket | undefined
  fuaMin!: number
  /** Dense home for every buffer this repacketizer builds (`output-arena.ts`). */
  private readonly arena = new OutputArena()

  constructor(
    public console: Console,
    private maxPacketSize: number,
    public codecInfo?: H264CodecInfo,
    public jitterBuffer = new JitterBuffer(console, 4),
  ) {
    this.setMaxPacketSize(maxPacketSize)
  }

  setMaxPacketSize(maxPacketSize: number): void {
    this.maxPacketSize = maxPacketSize
    // 12 is the rtp/srtp header size.
    this.fuaMax = maxPacketSize - FU_A_HEADER_SIZE
    this.fuaMin = Math.round(maxPacketSize * 0.8)
  }

  ensureCodecInfo(): H264CodecInfo {
    if (!this.codecInfo) {
      this.codecInfo = {}
    }
    return this.codecInfo
  }

  updateSps(sps: Buffer): void {
    this.ensureCodecInfo().sps = Buffer.from(sps)
  }

  updatePps(pps: Buffer): void {
    this.ensureCodecInfo().pps = Buffer.from(pps)
  }

  updateSei(sei: Buffer): void {
    this.ensureCodecInfo().sei = Buffer.from(sei)
  }

  shouldFilter(_nalType: number): boolean {
    // Currently nothing is filtered, but this could be customized.
    return false
  }

  // a fragmentation unit (fua) is a NAL unit broken into multiple fragments.
  // https://datatracker.ietf.org/doc/html/rfc6184#section-5.8
  //
  // One output per fragment, written in place: the FU indicator and header go
  // straight into the arena slice and the payload is copied behind them. This
  // used to build up to three FU headers with `Buffer.from([...])`, concat the
  // NAL header onto an incoming FU-A, and concat header + payload per fragment:
  // four pooled allocations for each packet that left. A single-fragment NAL
  // carries the END header (the start bit is overwritten), as it always did.
  packetizeFuA(data: Buffer, noStart?: boolean, noEnd?: boolean): Buffer[] {
    // handle both normal packets and fua packets.
    // a fua packet can be fragmented easily into smaller packets, as
    // it is already a fragment, and splitting segments is trivial.
    let nalHeader: number
    let bodyStart: number
    if ((data[0]! & 0x1f) === NAL_TYPE_FU_A) {
      const isFuStart = !!(data[1]! & 0x80)
      const isFuEnd = !!(data[1]! & 0x40)
      // The NAL header is rebuilt from the FU indicator + FU header, so the
      // body starts after those two bytes.
      nalHeader = (data[0]! & (0x80 | 0x60)) | (data[1]! & 0x1f)
      bodyStart = FU_A_HEADER_SIZE

      if (isFuStart) {
        noEnd = true
      } else if (isFuEnd) {
        noStart = true
      } else {
        noStart = true
        noEnd = true
      }
    } else {
      nalHeader = data[0]!
      bodyStart = NAL_HEADER_SIZE
    }

    const nalType = nalHeader & 0x1f
    const fuIndicator = (nalHeader & (0x80 | 0x60)) | NAL_TYPE_FU_A
    const startHeader = noStart ? nalType : nalType | 0x80
    const endHeader = noEnd ? nalType : nalType | 0x40

    const packages: Buffer[] = []
    let offset = bodyStart
    let first = true

    while (offset < data.length) {
      const packageSize = Math.min(this.fuaMax, data.length - offset)
      const last = offset + packageSize === data.length

      const out = this.arena.take(FU_A_HEADER_SIZE + packageSize)
      out[0] = fuIndicator
      out[1] = last ? endHeader : first ? startHeader : nalType
      data.copy(out, FU_A_HEADER_SIZE, offset, offset + packageSize)
      packages.push(out)

      offset += packageSize
      first = false
    }

    return packages
  }

  // https://datatracker.ietf.org/doc/html/rfc6184#section-5.7.1
  packetizeOneStapA(datas: Buffer[]): Buffer {
    if (!datas.length) throw new Error('packetizeOneStapA requires at least one NAL')

    const taken: Buffer[] = []
    let availableSize = this.maxPacketSize - STAP_A_HEADER_SIZE

    // h264/rtp spec: https://datatracker.ietf.org/doc/html/rfc6184#section-5.6
    // homekit does not want NRI aggregation in the sps/pps stap-a.
    const stapHeader = NAL_TYPE_STAP_A

    while (
      datas.length &&
      datas[0]!.length + LENGTH_FIELD_SIZE <= availableSize &&
      taken.length < 9
    ) {
      const nalu = datas.shift()!
      availableSize -= LENGTH_FIELD_SIZE + nalu.length
      taken.push(nalu)
    }

    // when a stapa packet has a p frame inside it, it may exceed the max packet size.
    // it needs to be returned as is to be turned into a fua packet.
    if (taken.length === 0) return datas.shift()!

    // a single nalu stapa is unnecessary, return the nalu itself.
    if (taken.length === 1) return taken[0]!

    // One output: the STAP header, then each NAL behind its 16-bit length.
    let total = 1
    for (const nalu of taken) total += LENGTH_FIELD_SIZE + nalu.length
    const out = this.arena.take(total)
    out[0] = stapHeader
    let offset = 1
    for (const nalu of taken) {
      out.writeUInt16BE(nalu.length, offset)
      nalu.copy(out, offset + LENGTH_FIELD_SIZE)
      offset += LENGTH_FIELD_SIZE + nalu.length
    }
    return out
  }

  packetizeStapA(datas: Buffer[]): Buffer[] {
    const ret: Buffer[] = []
    while (datas.length) {
      const nalu = this.packetizeOneStapA(datas)
      if (nalu.length < this.maxPacketSize) {
        ret.push(nalu)
        continue
      }
      const fuas = this.packetizeFuA(nalu)
      ret.push(...fuas)
    }
    return ret
  }

  createPacket(rtp: RtpPacket, data: Buffer, marker: boolean): RtpPacket {
    const ret = rtp.clone()
    ret.header.sequenceNumber = (rtp.header.sequenceNumber + this.extraPackets + 0x10000) % 0x10000
    ret.header.marker = marker
    ret.header.padding = false
    ret.payload = data
    if (data.length > this.maxPacketSize)
      this.console.warn('packet exceeded max packet size. this may be a bug.')
    return ret
  }

  flushPendingFuA(ret: RtpPacket[]): void {
    const pending = this.pendingFuA
    if (!pending || pending.length === 0) return

    // defragmenting assumes packets are sorted by sequence number,
    // and are all available, which is guaranteed over rtsp/tcp, but not over rtp/udp.
    const first = pending[0]!
    const last = pending[pending.length - 1]!
    const originalNalType = first.payload[1]! & 0x1f
    const hasFuStart = !!(first.payload[1]! & 0x80)
    const hasFuEnd = !!(last.payload[1]! & 0x40)

    const fnri = first.payload[0]! & (0x80 | 0x60)
    const originalNalHeader = fnri | originalNalType

    // The NAL header, then every fragment's body: one output, written in place.
    const getDefragmentedPendingFua = (): Buffer => {
      let total = NAL_HEADER_SIZE
      for (const packet of pending) total += packet.payload.length - FU_A_HEADER_SIZE
      const out = this.arena.take(total)
      out[0] = originalNalHeader
      let offset = NAL_HEADER_SIZE
      for (const packet of pending) {
        offset += packet.payload.copy(out, offset, FU_A_HEADER_SIZE)
      }
      return out
    }

    // have seen cameras that toss sps/pps/idr into a fua, delimited by start codes.
    // so the fua packet looks like: sps | start code | pps | start code | idr
    if (originalNalType === NAL_TYPE_SPS) {
      const defragmented = getDefragmentedPendingFua()

      const splits = splitH264NaluStartCode(defragmented)
      while (splits.length) {
        const split = splits.shift()!
        const splitNaluType = split[0]! & 0x1f
        if (splitNaluType === NAL_TYPE_SPS) {
          this.updateSps(split)
        } else if (splitNaluType === NAL_TYPE_PPS) {
          this.updatePps(split)
        } else {
          if (splitNaluType === NAL_TYPE_IDR) this.maybeSendStapACodecInfo(first, ret)

          this.fragment(first, ret, {
            payload: split,
            noStart: !hasFuStart,
            noEnd: !hasFuEnd,
            marker: last.header.marker,
          })
        }
      }
    } else {
      while (pending.length) {
        const fua = pending[0]!
        if (fua.payload.length > this.maxPacketSize || fua.payload.length < this.fuaMin) break
        pending.shift()
        ret.push(this.createPacket(fua, fua.payload, fua.header.marker))
      }

      if (!pending.length) {
        this.pendingFuA = undefined
        return
      }

      const refragFirst = pending[0]!
      const refragLast = pending[pending.length - 1]!
      const refragHasFuStart = !!(refragFirst.payload[1]! & 0x80)
      const refragHasFuEnd = !!(refragLast.payload[1]! & 0x40)

      const defragmented = getDefragmentedPendingFua()

      this.fragment(refragFirst, ret, {
        payload: defragmented,
        noStart: !refragHasFuStart,
        noEnd: !refragHasFuEnd,
        marker: refragLast.header.marker,
      })
    }

    this.extraPackets -= pending.length - 1
    this.pendingFuA = undefined
  }

  createRtpPackets(
    packet: RtpPacket,
    nalus: Buffer[],
    ret: RtpPacket[],
    hadMarker = packet.header.marker,
  ): void {
    nalus.forEach((packetized, index) => {
      if (index !== 0) this.extraPackets++
      const marker = hadMarker && index === nalus.length - 1
      ret.push(this.createPacket(packet, packetized, marker))
    })
  }

  maybeSendStapACodecInfo(packet: RtpPacket, ret: RtpPacket[]): void {
    if (this.stapa) {
      // stapa with codec information was sent recently, no need to send codec info.
      this.stapa = undefined
      return
    }

    if (!this.codecInfo?.sps || !this.codecInfo?.pps) return

    const agg = [this.codecInfo.sps, this.codecInfo.pps]
    if (this.codecInfo?.sei) agg.push(this.codecInfo.sei)
    const aggregates = this.packetizeStapA(agg)
    if (aggregates.length !== 1) {
      this.console.error('expected only 1 packet for sps/pps stapa')
      return
    }
    // this stapa only contains sps and pps (and no frame data), thus the marker bit should not be set.
    this.createRtpPackets(packet, aggregates, ret, false)
    this.extraPackets++
  }

  // given the packet, fragment it into multiple packets as needed.
  // a fragment of a payload may be provided via fuaOptions.
  fragment(
    packet: RtpPacket,
    ret: RtpPacket[],
    fuaOptions: FuaFragmentOptions = {
      payload: packet.payload,
      noStart: false,
      noEnd: false,
      marker: packet.header.marker,
    },
  ): void {
    const { payload, noStart, noEnd, marker } = fuaOptions
    if (payload.length > this.maxPacketSize || noStart || noEnd) {
      const fragments = this.packetizeFuA(payload, noStart, noEnd)
      this.createRtpPackets(packet, fragments, ret, marker)
    } else {
      // can send this packet as is!
      ret.push(this.createPacket(packet, payload, marker))
    }
  }

  repacketize<T extends RtpPacket>(packet: T): T[] {
    const ret: T[] = []
    for (const dejittered of this.jitterBuffer.queue(packet)) {
      this.repacketizeOne(dejittered, ret)
    }
    return ret
  }

  repacketizeOne(packet: RtpPacket, ret: RtpPacket[]): void {
    // empty packets are apparently valid from webrtc. filter those out.
    if (!packet.payload.length) {
      this.flushPendingFuA(ret)
      this.extraPackets--
      return
    }

    const nalType = packet.payload[0]! & 0x1f

    // fragmented packets must share a timestamp
    if (this.pendingFuA && this.pendingFuA[0]!.header.timestamp !== packet.header.timestamp) {
      this.flushPendingFuA(ret)
    }

    if (nalType === NAL_TYPE_FU_A) {
      // ideally send the packets through as is from the upstream source.
      // refragment only if the incoming fua packet is larger than the max packet size.
      const data = packet.payload
      const originalNalType = data[1]! & 0x1f

      if (this.shouldFilter(originalNalType)) {
        this.extraPackets--
        return
      }

      const isFuStart = !!(data[1]! & 0x80)

      if (isFuStart) {
        if (this.pendingFuA)
          this.console.error(
            'fua restarted. skipping refragmentation of previous fua.',
            originalNalType,
          )

        this.pendingFuA = undefined

        // if this is an idr frame, but no sps has been sent via a stapa, dummy one up.
        // the stream may not contain codec information in stapa or may be sending it
        // in separate sps/pps packets.
        if (originalNalType === NAL_TYPE_IDR) {
          this.maybeSendStapACodecInfo(packet, ret)
        }
      } else {
        if (this.pendingFuA) {
          // check if packets were missing earlier from the previously queued fua packets.
          // if so, don't queue the current packet. all further fua packets are dropped
          // until a later fua start is received.
          const last = this.pendingFuA[this.pendingFuA.length - 1]!
          if (!isNextSequenceNumber(last.header.sequenceNumber, packet.header.sequenceNumber)) {
            this.console.error('fua packet missing. skipping refragmentation.', originalNalType)
            return
          }
        }
      }

      if (!this.pendingFuA) this.pendingFuA = []

      this.pendingFuA.push(packet)

      const isFuEnd = !!(packet.payload[1]! & 0x40)
      if (isFuEnd) {
        this.flushPendingFuA(ret)
      } else if (
        this.pendingFuA.reduce((p, c) => p + c.payload.length - FU_A_HEADER_SIZE, NAL_HEADER_SIZE) >
        this.maxPacketSize
      ) {
        // refragment fua packets as they are received, saving the last undersized packet for
        // the next fua packet.
        const last = this.pendingFuA[this.pendingFuA.length - 1]!.clone()
        const partial: RtpPacket[] = []
        this.flushPendingFuA(partial)
        // retain a fua packet to validate subsequent fua packets.
        const retain = partial.pop()
        if (retain) last.payload = retain.payload
        this.pendingFuA = [last]
        ret.push(...partial)
      }
    } else if (nalType === NAL_TYPE_STAP_A) {
      this.flushPendingFuA(ret)

      let hasSps = false
      let hasPps = false

      // break the aggregated packet up to update codec information.
      const depacketized = depacketizeStapA(packet.payload)
      depacketized.forEach((payload) => {
        const stapNalType = payload[0]! & 0x1f
        if (stapNalType === NAL_TYPE_SPS) {
          hasSps = true
          this.updateSps(payload)
        } else if (stapNalType === NAL_TYPE_PPS) {
          hasPps = true
          this.updatePps(payload)
        } else if (stapNalType === NAL_TYPE_SEI) {
          this.updateSei(payload)
        }
        // NAL_TYPE_DELIMITER / NON_IDR / IDR / 0 inside a stapa are uncommon
        // but harmless — re-aggregated below as-is.
      })

      // log that a stapa with codec info was sent
      if (hasSps && hasPps) this.stapa = packet

      const stapa = this.packetizeStapA(depacketized)
      this.createRtpPackets(packet, stapa, ret)
    } else if (nalType >= 1 && nalType < 24) {
      this.flushPendingFuA(ret)

      if (this.shouldFilter(nalType)) {
        this.extraPackets--
        return
      }

      // codec information should be aggregated into a stapa. usually around 50 bytes total.
      if (nalType === NAL_TYPE_SPS) {
        this.extraPackets--
        this.updateSps(packet.payload)
        return
      } else if (nalType === NAL_TYPE_PPS) {
        this.extraPackets--
        this.updatePps(packet.payload)
        return
      } else if (nalType === NAL_TYPE_SEI) {
        this.extraPackets--
        this.updateSei(packet.payload)
        return
      }

      if (nalType === NAL_TYPE_IDR) {
        // if this is an idr frame, but no sps has been sent, dummy one up.
        this.maybeSendStapACodecInfo(packet, ret)
      }

      this.fragment(packet, ret)
    } else {
      this.console.error('unknown nal unit type ' + nalType)
      this.extraPackets--
    }
  }
}
