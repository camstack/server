/**
 * Bounded single-program MPEG-TS demux for the ffmpeg SOURCE reader.
 *
 * The source reader spawns `ffmpeg ... -c copy -f mpegts pipe:1` (see
 * `ffmpeg-source-reader-args.ts`) to normalize a camera's bad cloud
 * timestamps without re-encoding. This class turns that MPEG-TS byte
 * stream (arriving in arbitrary pipe chunks) back into per-access-unit
 * `EncodedPacket`s the broker's `pushEncodedPacket` accepts, preserving
 * A/V sync and the ffmpeg-normalized PTS.
 *
 * Scope is deliberately narrow — the exact shape ffmpeg's `mpegts` muxer
 * produces for a single program with one video + one audio elementary
 * stream. It is NOT a general libav-class demuxer: PSI sections are
 * assumed to fit in one TS packet, only the stream types ffmpeg emits
 * are mapped, and PES reassembly keys off the payload-unit-start
 * indicator. Pure: the only outputs are the injected callbacks.
 *
 * PTS unit: `EncodedPacket.pts`/`dts` are MILLISECONDS across the broker
 * (see the push AnnexB path in `stream-broker.ts`: `Math.floor(ts90k / 90)`),
 * so the 90kHz MPEG-TS PTS is converted the same way here.
 */

import type { EncodedPacket, IScopedLogger } from '@camstack/types'

const TS_PACKET_SIZE = 188
const SYNC_BYTE = 0x47
const PAT_PID = 0x0000

/** Detected elementary-stream codecs, surfaced once the PMT is parsed. */
export interface MpegTsCodecInfo {
  readonly video?: string
  readonly audio?: string
}

export interface MpegTsDemuxOptions {
  /** Emitted once per completed access unit / audio PES. */
  readonly onPacket: (packet: EncodedPacket) => void
  /** Emitted once, right after the PMT is parsed. */
  readonly onCodecs?: (info: MpegTsCodecInfo) => void
  readonly logger?: IScopedLogger
}

/**
 * MPEG-TS → `EncodedPacket` demux. Map stream_type → codec:
 * 0x1b→h264, 0x24→h265, 0x0f→aac, 0x03/0x04→mp2, 0x81→ac3.
 */
function videoCodecForStreamType(streamType: number): string | undefined {
  if (streamType === 0x1b) return 'h264'
  if (streamType === 0x24) return 'h265'
  return undefined
}

function audioCodecForStreamType(streamType: number): string | undefined {
  if (streamType === 0x0f) return 'aac'
  if (streamType === 0x03 || streamType === 0x04) return 'mp2'
  if (streamType === 0x81) return 'ac3'
  return undefined
}

interface PendingPes {
  readonly chunks: Buffer[]
}

export class MpegTsDemux {
  private readonly onPacket: (packet: EncodedPacket) => void
  private readonly onCodecs: ((info: MpegTsCodecInfo) => void) | undefined
  private readonly logger: IScopedLogger | undefined

  /** Leftover bytes that did not complete a 188-byte TS packet yet. */
  private buffer: Buffer = Buffer.alloc(0)

  private pmtPid: number | null = null
  private videoPid: number | null = null
  private audioPid: number | null = null
  private videoCodec: string | undefined
  private audioCodec: string | undefined
  private codecsEmitted = false

  /** In-flight PES payload per elementary PID (flushed on next PUSI). */
  private readonly pending = new Map<number, PendingPes>()

  constructor(opts: MpegTsDemuxOptions) {
    this.onPacket = opts.onPacket
    this.onCodecs = opts.onCodecs
    this.logger = opts.logger
  }

  /** Feed raw pipe bytes; emits `EncodedPacket`s as PES units complete. */
  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    let offset = 0
    while (this.buffer.length - offset >= TS_PACKET_SIZE) {
      if (this.buffer[offset] !== SYNC_BYTE) {
        const resync = this.findSyncOffset(offset)
        if (resync === null) break
        offset = resync
        if (this.buffer.length - offset < TS_PACKET_SIZE) break
      }
      this.handleTsPacket(this.buffer.subarray(offset, offset + TS_PACKET_SIZE))
      offset += TS_PACKET_SIZE
    }
    this.buffer = offset === 0 ? this.buffer : this.buffer.subarray(offset)
  }

  /**
   * Emit any in-flight PES units and clear parser state. Call on EOF /
   * teardown so the final access unit (which has no following PUSI to
   * close it) is not dropped, then reuse the instance for a new stream.
   */
  reset(): void {
    this.flush()
    this.buffer = Buffer.alloc(0)
    this.pmtPid = null
    this.videoPid = null
    this.audioPid = null
    this.videoCodec = undefined
    this.audioCodec = undefined
    this.codecsEmitted = false
    this.pending.clear()
  }

  /**
   * Emit all in-flight PES units WITHOUT tearing down parser state. Call
   * on pipe EOF to release the final access unit; unlike `reset()` the
   * discovered PIDs/codecs survive.
   */
  flush(): void {
    for (const [pid, pes] of this.pending) this.emitPes(pid, pes)
    this.pending.clear()
  }

  /** Confirmed resync: a 0x47 whose +188 neighbour is also 0x47 (when loaded). */
  private findSyncOffset(from: number): number | null {
    for (let i = from; i <= this.buffer.length - TS_PACKET_SIZE; i++) {
      if (this.buffer[i] !== SYNC_BYTE) continue
      const next = i + TS_PACKET_SIZE
      if (next > this.buffer.length - 1 || this.buffer[next] === SYNC_BYTE) return i
    }
    return null
  }

  private handleTsPacket(pkt: Buffer): void {
    const pusi = (pkt[1]! & 0x40) !== 0
    const pid = ((pkt[1]! & 0x1f) << 8) | pkt[2]!
    const adaptationControl = (pkt[3]! & 0x30) >> 4

    // adaptation_field_control: 0b01 payload only, 0b11 adaptation+payload,
    // 0b10 adaptation only (no payload), 0b00 reserved.
    if (adaptationControl === 0b00 || adaptationControl === 0b10) return

    let payloadStart = 4
    if (adaptationControl === 0b11) {
      const adaptationLength = pkt[4]!
      payloadStart = 5 + adaptationLength
    }
    if (payloadStart >= TS_PACKET_SIZE) return
    const payload = pkt.subarray(payloadStart)

    if (pid === PAT_PID) {
      if (pusi) this.parsePat(payload)
      return
    }
    if (this.pmtPid !== null && pid === this.pmtPid) {
      if (pusi) this.parsePmt(payload)
      return
    }
    if (pid === this.videoPid || pid === this.audioPid) {
      this.accumulatePes(pid, payload, pusi)
    }
  }

  /** PAT: table_id 0x00; take the first non-zero program's PMT PID. */
  private parsePat(payload: Buffer): void {
    const section = this.stripPointer(payload)
    if (section === null || section[0] !== 0x00) return
    const sectionLength = ((section[1]! & 0x0f) << 8) | section[2]!
    // header up to last_section_number = 8 bytes; loop until CRC (last 4).
    const loopEnd = 3 + sectionLength - 4
    for (let i = 8; i + 4 <= loopEnd; i += 4) {
      const programNumber = (section[i]! << 8) | section[i + 1]!
      const pid = ((section[i + 2]! & 0x1f) << 8) | section[i + 3]!
      if (programNumber !== 0) {
        this.pmtPid = pid
        return
      }
    }
  }

  /** PMT: table_id 0x02; extract the video + audio elementary PIDs. */
  private parsePmt(payload: Buffer): void {
    const section = this.stripPointer(payload)
    if (section === null || section[0] !== 0x02) return
    const sectionLength = ((section[1]! & 0x0f) << 8) | section[2]!
    const programInfoLength = ((section[10]! & 0x0f) << 8) | section[11]!
    let i = 12 + programInfoLength
    const loopEnd = 3 + sectionLength - 4
    while (i + 5 <= loopEnd) {
      const streamType = section[i]!
      const elementaryPid = ((section[i + 1]! & 0x1f) << 8) | section[i + 2]!
      const esInfoLength = ((section[i + 3]! & 0x0f) << 8) | section[i + 4]!
      const video = videoCodecForStreamType(streamType)
      const audio = audioCodecForStreamType(streamType)
      if (video !== undefined && this.videoPid === null) {
        this.videoPid = elementaryPid
        this.videoCodec = video
      } else if (audio !== undefined && this.audioPid === null) {
        this.audioPid = elementaryPid
        this.audioCodec = audio
      }
      i += 5 + esInfoLength
    }
    if (!this.codecsEmitted && (this.videoCodec !== undefined || this.audioCodec !== undefined)) {
      this.codecsEmitted = true
      this.logger?.debug(
        `MpegTsDemux: PMT parsed video=${this.videoCodec ?? 'none'} audio=${this.audioCodec ?? 'none'}`,
      )
      this.onCodecs?.({ video: this.videoCodec, audio: this.audioCodec })
    }
  }

  /** Skip the PSI pointer_field (present on a PUSI section payload). */
  private stripPointer(payload: Buffer): Buffer | null {
    if (payload.length < 1) return null
    const pointer = payload[0]!
    const start = 1 + pointer
    if (start >= payload.length) return null
    return payload.subarray(start)
  }

  private accumulatePes(pid: number, payload: Buffer, pusi: boolean): void {
    if (pusi) {
      const existing = this.pending.get(pid)
      if (existing) this.emitPes(pid, existing)
      this.pending.set(pid, { chunks: [payload] })
      return
    }
    const pending = this.pending.get(pid)
    if (pending) pending.chunks.push(payload)
  }

  private emitPes(pid: number, pes: PendingPes): void {
    const body = pes.chunks.length === 1 ? pes.chunks[0]! : Buffer.concat(pes.chunks)
    const parsed = parsePesHeader(body)
    if (parsed === null) return
    const isVideo = pid === this.videoPid
    const codec = isVideo ? this.videoCodec : this.audioCodec
    if (codec === undefined) return
    if (parsed.payload.length === 0) return

    const ptsMs = parsed.pts90k === null ? 0 : Math.floor(parsed.pts90k / 90)
    const dtsMs = parsed.dts90k === null ? ptsMs : Math.floor(parsed.dts90k / 90)

    const packet: EncodedPacket = {
      type: isVideo ? 'video' : 'audio',
      data: parsed.payload,
      pts: ptsMs,
      dts: dtsMs,
      keyframe: isVideo ? isAnnexBKeyframe(parsed.payload, codec) : false,
      codec,
    }
    this.onPacket(packet)
  }
}

interface ParsedPes {
  readonly payload: Buffer
  readonly pts90k: number | null
  readonly dts90k: number | null
}

/**
 * Parse a PES packet: `00 00 01` start prefix, stream_id, optional PES
 * header carrying PTS/DTS. Returns the elementary payload plus the 33-bit
 * PTS/DTS in 90kHz ticks. Returns `null` when the start prefix is absent.
 */
function parsePesHeader(pes: Buffer): ParsedPes | null {
  if (pes.length < 9) return null
  if (pes[0] !== 0x00 || pes[1] !== 0x00 || pes[2] !== 0x01) return null

  const flags = pes[7]!
  const ptsDtsFlags = (flags & 0xc0) >> 6
  const headerDataLength = pes[8]!
  const payloadStart = 9 + headerDataLength
  if (payloadStart > pes.length) return null

  let pts90k: number | null = null
  let dts90k: number | null = null
  if (ptsDtsFlags === 0b10 && pes.length >= 14) {
    pts90k = readTimestamp(pes, 9)
  } else if (ptsDtsFlags === 0b11 && pes.length >= 19) {
    pts90k = readTimestamp(pes, 9)
    dts90k = readTimestamp(pes, 14)
  }

  return { payload: pes.subarray(payloadStart), pts90k, dts90k }
}

/**
 * Read a 33-bit MPEG timestamp from the 5-byte marker-bit layout at
 * `offset`. Uses arithmetic (not `<<`) for the high bits so values above
 * 2^31 do not overflow JS's 32-bit bitwise ops.
 */
function readTimestamp(buf: Buffer, offset: number): number {
  const b0 = buf[offset]!
  const b1 = buf[offset + 1]!
  const b2 = buf[offset + 2]!
  const b3 = buf[offset + 3]!
  const b4 = buf[offset + 4]!
  return (
    ((b0 >> 1) & 0x07) * 2 ** 30 +
    b1 * 2 ** 22 +
    ((b2 >> 1) & 0x7f) * 2 ** 15 +
    b3 * 2 ** 7 +
    ((b4 >> 1) & 0x7f)
  )
}

/**
 * Annex-B keyframe test. Scan NAL start codes (00 00 01 / 00 00 00 01):
 * H.264 → an IDR (type 5) or SPS (type 7); H.265 → an IRAP (types 16–23)
 * or VPS/SPS (32/33).
 */
function isAnnexBKeyframe(data: Buffer, codec: string): boolean {
  const isH265 = codec === 'h265'
  let i = 0
  while (i + 3 < data.length) {
    if (data[i] === 0x00 && data[i + 1] === 0x00 && data[i + 2] === 0x01) {
      const header = data[i + 3]!
      if (isH265) {
        const nalType = (header >> 1) & 0x3f
        if ((nalType >= 16 && nalType <= 23) || nalType === 32 || nalType === 33) return true
      } else {
        const nalType = header & 0x1f
        if (nalType === 5 || nalType === 7) return true
      }
      i += 3
    } else {
      i++
    }
  }
  return false
}
