/**
 * RTP packet sequences for ONE picture at a time — the shapes real cameras
 * send, as the broker's access-unit grouping specs need them.
 *
 * Every builder returns the RTP packets of one access unit in wire order,
 * stamped with one 90 kHz timestamp and the marker bit on the last packet
 * only (or on none, for the marker-less camera). H.264 bodies are built the
 * way `rtp-annexb-zero-copy.spec.ts` builds them; H.265 adds the AP and FU
 * payloads of RFC 7798.
 */

const RTP_HEADER_SIZE = 12
const PAYLOAD_TYPE = 96

export interface RtpOptions {
  readonly seq: number
  readonly timestamp: number
  readonly marker: boolean
  readonly payload: Buffer
}

export function rtp(opts: RtpOptions): Buffer {
  const header = Buffer.alloc(RTP_HEADER_SIZE)
  header[0] = 0x80
  header[1] = (opts.marker ? 0x80 : 0x00) | PAYLOAD_TYPE
  header.writeUInt16BE(opts.seq & 0xffff, 2)
  header.writeUInt32BE(opts.timestamp >>> 0, 4)
  header.writeUInt32BE(0x11223344, 8)
  return Buffer.concat([header, opts.payload])
}

/** Marker bit of an RTP packet. */
export function rtpMarker(packet: Buffer): boolean {
  return (packet[1]! & 0x80) !== 0
}

// ── H.264 NAL bodies ───────────────────────────────────────────────

export const H264 = {
  SPS: 7,
  PPS: 8,
  IDR: 5,
  SLICE: 1,
  SEI: 6,
  STAP_A: 24,
  FU_A: 28,
} as const

/** A complete H.264 NAL unit (header byte + body). */
export function h264Nal(type: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x60 | type]), body])
}

/** FU-A fragments of one H.264 NAL, `fragments` packets long. */
function h264FuA(nal: Buffer, fragments: number): Buffer[] {
  const type = nal[0]! & 0x1f
  const body = nal.subarray(1)
  const size = Math.ceil(body.length / fragments)
  const out: Buffer[] = []
  for (let i = 0; i < fragments; i++) {
    const start = i === 0
    const end = i === fragments - 1
    const fuIndicator = 0x60 | H264.FU_A
    const fuHeader = (start ? 0x80 : 0) | (end ? 0x40 : 0) | type
    out.push(
      Buffer.concat([
        Buffer.from([fuIndicator, fuHeader]),
        body.subarray(i * size, (i + 1) * size),
      ]),
    )
  }
  return out
}

/** One STAP-A payload aggregating `nals`. */
function h264StapA(nals: readonly Buffer[]): Buffer {
  const parts: Buffer[] = [Buffer.from([0x60 | H264.STAP_A])]
  for (const nal of nals) {
    const size = Buffer.alloc(2)
    size.writeUInt16BE(nal.length, 0)
    parts.push(size, nal)
  }
  return Buffer.concat(parts)
}

// ── H.265 NAL bodies ───────────────────────────────────────────────

export const H265 = {
  VPS: 32,
  SPS: 33,
  PPS: 34,
  IDR_W_RADL: 19,
  TRAIL_R: 1,
  PREFIX_SEI: 39,
  AP: 48,
  FU: 49,
} as const

/** A complete H.265 NAL unit (2-byte header + body). */
export function h265Nal(type: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(type << 1) & 0x7e, 0x01]), body])
}

/** FU payloads of one H.265 NAL, `fragments` packets long. */
function h265Fu(nal: Buffer, fragments: number): Buffer[] {
  const type = (nal[0]! >> 1) & 0x3f
  const body = nal.subarray(2)
  const size = Math.ceil(body.length / fragments)
  const out: Buffer[] = []
  for (let i = 0; i < fragments; i++) {
    const start = i === 0
    const end = i === fragments - 1
    const fuHeader = (start ? 0x80 : 0) | (end ? 0x40 : 0) | type
    out.push(
      Buffer.concat([
        Buffer.from([(H265.FU << 1) & 0x7e, 0x01, fuHeader]),
        body.subarray(i * size, (i + 1) * size),
      ]),
    )
  }
  return out
}

/** One AP payload aggregating `nals`. */
function h265Ap(nals: readonly Buffer[]): Buffer {
  const parts: Buffer[] = [Buffer.from([(H265.AP << 1) & 0x7e, 0x01])]
  for (const nal of nals) {
    const size = Buffer.alloc(2)
    size.writeUInt16BE(nal.length, 0)
    parts.push(size, nal)
  }
  return Buffer.concat(parts)
}

// ── Pictures ───────────────────────────────────────────────────────

export type Codec = 'h264' | 'h265'

/** How one picture's NALs travel on the wire. */
export type Packaging = 'single' | 'fu' | 'ap'

export interface PictureOptions {
  readonly codec: Codec
  /** First RTP sequence number of the picture. */
  readonly seq: number
  readonly timestamp: number
  /** Parameter sets open the picture (a keyframe picture). */
  readonly withParams: boolean
  /** A prefix SEI follows the parameter sets and precedes the first slice. */
  readonly withPrefixSei?: boolean
  /** Keyframe (IDR/IRAP) slices, else P slices. */
  readonly keyframe: boolean
  readonly slices: number
  /** Bytes per slice body. */
  readonly sliceBytes?: number
  /** `fu`: every slice fragmented in `fuFragments` packets; `ap`: params aggregated in one packet. */
  readonly packaging: Packaging
  readonly fuFragments?: number
  /** Marker-less camera: no packet carries the marker bit. */
  readonly noMarker?: boolean
}

export interface Picture {
  /** RTP packets, wire order. */
  readonly packets: readonly Buffer[]
  /** The Annex-B bytes a correct assembler must produce for this picture. */
  readonly annexB: Buffer
  /** Next free sequence number. */
  readonly nextSeq: number
}

const START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01])

function annexBOf(nals: readonly Buffer[]): Buffer {
  const parts: Buffer[] = []
  for (const nal of nals) parts.push(START_CODE, nal)
  return Buffer.concat(parts)
}

function parameterSetNals(codec: Codec): Buffer[] {
  if (codec === 'h264') {
    return [
      h264Nal(H264.SPS, Buffer.from([0x42, 0x00, 0x1f])),
      h264Nal(H264.PPS, Buffer.from([0xce, 0x3c, 0x80])),
    ]
  }
  return [
    h265Nal(H265.VPS, Buffer.from([0x0c, 0x01, 0xff, 0xff])),
    h265Nal(H265.SPS, Buffer.from([0x01, 0x01, 0x60, 0x00])),
    h265Nal(H265.PPS, Buffer.from([0xc0, 0xf3, 0xc0, 0x02])),
  ]
}

function sliceNal(codec: Codec, keyframe: boolean, index: number, bytes: number): Buffer {
  const body = Buffer.alloc(bytes, 0x10 + index)
  if (codec === 'h264') return h264Nal(keyframe ? H264.IDR : H264.SLICE, body)
  return h265Nal(keyframe ? H265.IDR_W_RADL : H265.TRAIL_R, body)
}

function prefixSeiNal(codec: Codec): Buffer {
  const body = Buffer.from([0x05, 0x04, 0xaa, 0xbb, 0xcc, 0xdd, 0x80])
  return codec === 'h264' ? h264Nal(H264.SEI, body) : h265Nal(H265.PREFIX_SEI, body)
}

/**
 * The RTP packets of one picture. Parameter sets travel one per packet
 * (`single`, `fu`) or aggregated into one STAP-A / AP packet (`ap`); slices
 * travel one per packet or fragmented (`fu`).
 */
export function picture(opts: PictureOptions): Picture {
  const sliceBytes = opts.sliceBytes ?? 600
  const fragments = opts.fuFragments ?? 3
  const nals: Buffer[] = []
  const payloads: Buffer[] = []

  if (opts.withParams) {
    const params = parameterSetNals(opts.codec)
    nals.push(...params)
    if (opts.packaging === 'ap') {
      payloads.push(opts.codec === 'h264' ? h264StapA(params) : h265Ap(params))
    } else {
      payloads.push(...params)
    }
  }
  if (opts.withPrefixSei === true) {
    const sei = prefixSeiNal(opts.codec)
    nals.push(sei)
    payloads.push(sei)
  }
  for (let i = 0; i < opts.slices; i++) {
    const slice = sliceNal(opts.codec, opts.keyframe, i, sliceBytes)
    nals.push(slice)
    if (opts.packaging === 'fu') {
      payloads.push(
        ...(opts.codec === 'h264' ? h264FuA(slice, fragments) : h265Fu(slice, fragments)),
      )
    } else {
      payloads.push(slice)
    }
  }

  let seq = opts.seq
  const packets = payloads.map((payload, i) =>
    rtp({
      seq: seq++,
      timestamp: opts.timestamp,
      marker: opts.noMarker !== true && i === payloads.length - 1,
      payload,
    }),
  )
  return { packets, annexB: annexBOf(nals), nextSeq: seq }
}

export interface GopOptions {
  readonly codec: Codec
  readonly seq: number
  readonly timestamp: number
  /** 90 kHz ticks between pictures (3600 = 25 fps). */
  readonly stepTicks: number
  readonly slicesPerPicture: number
  readonly pFrames: number
  readonly packaging: Packaging
  readonly withPrefixSei?: boolean
  readonly fuFragments?: number
  readonly noMarker?: boolean
}

export interface Gop {
  /** Every picture of the GOP, keyframe first. */
  readonly pictures: readonly Picture[]
  readonly packets: readonly Buffer[]
  readonly nextSeq: number
  readonly nextTimestamp: number
}

/** One keyframe picture (with parameter sets) followed by `pFrames` P pictures. */
export function gop(opts: GopOptions): Gop {
  const pictures: Picture[] = []
  let seq = opts.seq
  let timestamp = opts.timestamp
  for (let i = 0; i <= opts.pFrames; i++) {
    const keyframe = i === 0
    const pic = picture({
      codec: opts.codec,
      seq,
      timestamp,
      withParams: keyframe,
      withPrefixSei: keyframe && opts.withPrefixSei === true,
      keyframe,
      slices: opts.slicesPerPicture,
      packaging: opts.packaging,
      fuFragments: opts.fuFragments,
      noMarker: opts.noMarker,
    })
    pictures.push(pic)
    seq = pic.nextSeq
    timestamp += opts.stepTicks
  }
  return {
    pictures,
    packets: pictures.flatMap((p) => p.packets),
    nextSeq: seq,
    nextTimestamp: timestamp,
  }
}
