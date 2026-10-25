import type { EncodedPacket } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RtpDepacketizer, type RtpPacketClass } from '../rtsp/rtp-depacketizer.js'
import { RtpAccessUnitTracker, type RtpPacketAuFlags } from '../rtsp/rtp-access-unit-tracker.js'
import { RtspRestreamer } from '../rtsp/rtsp-restreamer.js'
import { MAX_MISSED_KEYFRAMES } from '../rtsp/rtsp-types.js'
import {
  AccessUnitAssembler,
  type AssembledAccessUnit,
} from '../stream-broker/access-unit-assembler.js'
import { tailWindow } from '../stream-broker/prebuffer-clip.js'
import {
  gop,
  picture,
  rtpMarker,
  type Codec,
  type Packaging,
} from './fixtures/nal-sequence-fixtures.js'
import {
  countRtpFrames,
  createMockSocket,
  destroyMockSockets,
  H265_SDP,
  playSession,
} from './fixtures/rtsp-session-mock.js'

/**
 * The broker's `EncodedPacket` is ONE ACCESS UNIT — never one NAL.
 *
 * `handleDepacketizedNal` used to turn every non-parameter-set NAL into its own
 * EncodedPacket, `keyframe` per NAL. On a 25 fps camera with 3 slices per
 * picture that was 75 "frames" a second, an 8–34 ms "GOP" (every IRAP slice
 * re-stamped `lastKeyframeMs`), a clip window widened back to the LAST IRAP
 * slice (a third of the picture, without its parameter sets), a prefix SEI that
 * inherited the welded VPS/SPS/PPS instead of the IDR, and a backlogged RTSP
 * client closed within one picture because `MAX_MISSED_KEYFRAMES` was counted
 * per IRAP packet. These specs pin the grouping at every consumer named above.
 */

const START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01])
const TICKS_25FPS = 3600

/** Depacketize → assemble, as the broker wires it; returns the assembled units. */
function assemble(codec: Codec, packets: readonly Buffer[]): AssembledAccessUnit[] {
  const out: AssembledAccessUnit[] = []
  const assembler = new AccessUnitAssembler((au) => out.push(au))
  const depacketizer = new RtpDepacketizer(codec, (nal) => assembler.push(nal))
  for (const p of packets) depacketizer.processPacket(p)
  return out
}

function toEncodedPacket(au: AssembledAccessUnit, codec: Codec): EncodedPacket {
  const pts = Math.floor(au.timestamp / 90)
  return { type: 'video', data: au.annexB, pts, dts: pts, keyframe: au.keyframe, codec }
}

/** Every NAL type in an Annex-B buffer, in order (4-byte start codes only, as the depacketizer writes them). */
function nalTypes(annexB: Buffer, codec: Codec): number[] {
  const types: number[] = []
  let offset = annexB.indexOf(START_CODE)
  while (offset >= 0) {
    const header = offset + START_CODE.length
    types.push(codec === 'h264' ? annexB[header]! & 0x1f : (annexB[header]! >> 1) & 0x3f)
    offset = annexB.indexOf(START_CODE, header)
  }
  return types
}

interface GroupingCase {
  readonly name: string
  readonly codec: Codec
  readonly packaging: Packaging
  readonly slices: number
  readonly paramTypes: readonly number[]
  readonly idrType: number
  readonly pType: number
}

const CASES: readonly GroupingCase[] = [
  {
    name: '(i) H.265 VPS,SPS,PPS + 3 IRAP slices FU-fragmented, then 3 P pictures of 3 slices',
    codec: 'h265',
    packaging: 'fu',
    slices: 3,
    paramTypes: [32, 33, 34],
    idrType: 19,
    pType: 1,
  },
  {
    name: '(ii) the same picture shapes with the parameter sets in one AP packet',
    codec: 'h265',
    packaging: 'ap',
    slices: 3,
    paramTypes: [32, 33, 34],
    idrType: 19,
    pType: 1,
  },
  {
    name: '(iii) H.264 SPS,PPS + 2 IDR slices, then P pictures of 2 slices',
    codec: 'h264',
    packaging: 'single',
    slices: 2,
    paramTypes: [7, 8],
    idrType: 5,
    pType: 1,
  },
]

describe('AccessUnitAssembler — one EncodedPacket per picture', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const g = gop({
        codec: c.codec,
        seq: 1,
        timestamp: 90_000,
        stepTicks: TICKS_25FPS,
        slicesPerPicture: c.slices,
        pFrames: 3,
        packaging: c.packaging,
      })
      // More RTP packets than pictures — the grouping has something to do.
      expect(g.packets.length).toBeGreaterThan(g.pictures.length)

      const units = assemble(c.codec, g.packets)

      // ONE unit per picture, each byte-exact: parameter sets, then every slice.
      expect(units).toHaveLength(g.pictures.length)
      units.forEach((au, i) => {
        expect(au.annexB).toEqual(g.pictures[i]!.annexB)
        expect(au.timestamp).toBe(90_000 + i * TICKS_25FPS)
      })

      // The keyframe is the picture, not a slice: params + every IDR slice.
      expect(units[0]!.keyframe).toBe(true)
      expect(nalTypes(units[0]!.annexB, c.codec)).toEqual([
        ...c.paramTypes,
        ...Array.from({ length: c.slices }, () => c.idrType),
      ])
      for (const au of units.slice(1)) {
        expect(au.keyframe).toBe(false)
        expect(nalTypes(au.annexB, c.codec)).toEqual(
          Array.from({ length: c.slices }, () => c.pType),
        )
      }
    })
  }

  it('(iv) a prefix SEI before the IDR stays inside its picture and is never a frame of its own', () => {
    const pic = picture({
      codec: 'h265',
      seq: 1,
      timestamp: 90_000,
      withParams: true,
      withPrefixSei: true,
      keyframe: true,
      slices: 3,
      packaging: 'fu',
    })
    const next = picture({
      codec: 'h265',
      seq: pic.nextSeq,
      timestamp: 90_000 + TICKS_25FPS,
      withParams: false,
      keyframe: false,
      slices: 3,
      packaging: 'fu',
    })

    const units = assemble('h265', [...pic.packets, ...next.packets])

    expect(units).toHaveLength(2)
    // VPS, SPS, PPS, prefix SEI, IDR ×3 — one keyframe unit, in wire order.
    expect(nalTypes(units[0]!.annexB, 'h265')).toEqual([32, 33, 34, 39, 19, 19, 19])
    expect(units[0]!.annexB).toEqual(pic.annexB)
    expect(units[0]!.keyframe).toBe(true)
    expect(units[1]!.keyframe).toBe(false)
  })

  it('(v) a single-slice stream is unchanged: one packet per picture, emitted on the packet that carries it', () => {
    const g = gop({
      codec: 'h264',
      seq: 1,
      timestamp: 0,
      stepTicks: TICKS_25FPS,
      slicesPerPicture: 1,
      pFrames: 5,
      packaging: 'single',
    })

    const out: AssembledAccessUnit[] = []
    const assembler = new AccessUnitAssembler((au) => out.push(au))
    const depacketizer = new RtpDepacketizer('h264', (nal) => assembler.push(nal))

    // The keyframe picture is SPS, PPS, IDR — three packets, one unit, on the IDR.
    const [sps, pps, idr, ...pSlices] = g.packets
    depacketizer.processPacket(sps!)
    depacketizer.processPacket(pps!)
    expect(out).toHaveLength(0)
    depacketizer.processPacket(idr!)
    expect(out).toHaveLength(1)
    expect(out[0]!.keyframe).toBe(true)

    // Every P packet is a picture and is handed down synchronously — no
    // picture is held back waiting for the next timestamp.
    pSlices.forEach((p, i) => {
      expect(rtpMarker(p)).toBe(true)
      depacketizer.processPacket(p)
      expect(out).toHaveLength(2 + i)
      // The depacketizer's own buffer, verbatim: no copy for a one-NAL picture.
      expect(out[1 + i]!.annexB).toEqual(g.pictures[1 + i]!.annexB)
    })
  })

  it('a marker-less camera closes a picture on the next timestamp, and the broker flushes the last one', () => {
    const g = gop({
      codec: 'h264',
      seq: 1,
      timestamp: 0,
      stepTicks: TICKS_25FPS,
      slicesPerPicture: 2,
      pFrames: 2,
      packaging: 'single',
      noMarker: true,
    })
    const out: AssembledAccessUnit[] = []
    const assembler = new AccessUnitAssembler((au) => out.push(au))
    const depacketizer = new RtpDepacketizer('h264', (nal) => assembler.push(nal))
    for (const p of g.packets) depacketizer.processPacket(p)

    // The last picture has no boundary yet.
    expect(out).toHaveLength(2)
    assembler.flush()
    expect(out).toHaveLength(3)
    out.forEach((au, i) => expect(au.annexB).toEqual(g.pictures[i]!.annexB))
  })
})

describe('consumers of the access-unit EncodedPacket', () => {
  it('clip widening starts at the WHOLE keyframe picture — slice 1, with its parameter sets', () => {
    // Two GOPs of 3-slice pictures; a window that begins mid-second-GOP.
    const first = gop({
      codec: 'h265',
      seq: 1,
      timestamp: 0,
      stepTicks: TICKS_25FPS,
      slicesPerPicture: 3,
      pFrames: 24,
      packaging: 'fu',
    })
    const second = gop({
      codec: 'h265',
      seq: first.nextSeq,
      timestamp: first.nextTimestamp,
      stepTicks: TICKS_25FPS,
      slicesPerPicture: 3,
      pFrames: 24,
      packaging: 'fu',
    })
    const packets = assemble('h265', [...first.packets, ...second.packets]).map((au) =>
      toEncodedPacket(au, 'h265'),
    )
    expect(packets).toHaveLength(50)

    // 0.5 s back from the newest picture lands inside the second GOP; the
    // window must widen to the second keyframe PICTURE.
    const window = tailWindow(packets, 0.5)
    expect(window[0]!.keyframe).toBe(true)
    expect(window[0]!.data).toEqual(second.pictures[0]!.annexB)
    expect(nalTypes(window[0]!.data, 'h265')).toEqual([32, 33, 34, 19, 19, 19])
    // 0.5 s back is picture 37 (1 480 ms); widened to the keyframe at 1 000 ms:
    // pictures 25..49 — the whole second GOP.
    expect(window).toHaveLength(25)
  })
})

// ── The source-RTP plane: per-packet flags judged per access unit ─────

/** Classify a packet exactly as the broker's `onVideoRtp` arm does. */
function classifyAll(codec: Codec, packets: readonly Buffer[]): RtpPacketAuFlags[] {
  const depacketizer = new RtpDepacketizer(codec, () => {})
  const tracker = new RtpAccessUnitTracker()
  const out: RtpPacketAuFlags[] = []
  for (const p of packets) {
    const carried: RtpPacketClass | null = depacketizer.processPacket(p)
    if (carried) out.push(tracker.classify(carried))
  }
  return out
}

describe('RtpAccessUnitTracker — a keyframe is a picture, not a packet', () => {
  it('every fragment of a fragmented IDR picture is in the keyframe AU; the start fires once', () => {
    const g = gop({
      codec: 'h265',
      seq: 1,
      timestamp: 0,
      stepTicks: TICKS_25FPS,
      slicesPerPicture: 3,
      pFrames: 2,
      packaging: 'fu',
      withPrefixSei: true,
    })
    const flags = classifyAll('h265', g.packets)
    const keyframePackets = g.pictures[0]!.packets.length
    // 3 params + 1 SEI + 3 slices × 3 fragments.
    expect(keyframePackets).toBe(13)

    const inKeyframe = flags.filter((f) => f.keyframeAu)
    expect(inKeyframe).toHaveLength(keyframePackets)
    expect(flags.slice(0, keyframePackets).every((f) => f.keyframeAu)).toBe(true)
    expect(flags.slice(keyframePackets).every((f) => !f.keyframeAu)).toBe(true)

    const starts = flags.map((f, i) => (f.keyframeAuStart ? i : -1)).filter((i) => i >= 0)
    expect(starts).toEqual([0])
  })

  it('parameter sets stamped with the previous picture’s timestamp still announce ONE keyframe', () => {
    const params = picture({
      codec: 'h264',
      seq: 1,
      timestamp: 0,
      withParams: true,
      keyframe: true,
      slices: 0,
      packaging: 'single',
      noMarker: true,
    })
    const idr = picture({
      codec: 'h264',
      seq: params.nextSeq,
      timestamp: TICKS_25FPS,
      withParams: false,
      keyframe: true,
      slices: 2,
      packaging: 'fu',
    })
    const p = picture({
      codec: 'h264',
      seq: idr.nextSeq,
      timestamp: 2 * TICKS_25FPS,
      withParams: false,
      keyframe: false,
      slices: 2,
      packaging: 'single',
    })
    const flags = classifyAll('h264', [...params.packets, ...idr.packets, ...p.packets])
    expect(flags.filter((f) => f.keyframeAuStart)).toHaveLength(1)
    expect(flags[0]!.keyframeAuStart).toBe(true)
    const keyframeRun = params.packets.length + idr.packets.length
    expect(flags.slice(0, keyframeRun).every((f) => f.keyframeAu)).toBe(true)
    expect(flags.slice(keyframeRun).every((f) => !f.keyframeAu)).toBe(true)
  })

  it('an all-intra stream starts a keyframe AU on every picture', () => {
    const a = picture({
      codec: 'h264',
      seq: 1,
      timestamp: 0,
      withParams: true,
      keyframe: true,
      slices: 2,
      packaging: 'fu',
    })
    const b = picture({
      codec: 'h264',
      seq: a.nextSeq,
      timestamp: TICKS_25FPS,
      withParams: true,
      keyframe: true,
      slices: 2,
      packaging: 'fu',
    })
    const flags = classifyAll('h264', [...a.packets, ...b.packets])
    expect(flags.filter((f) => f.keyframeAuStart)).toHaveLength(2)
    expect(flags[0]!.keyframeAuStart).toBe(true)
    expect(flags[a.packets.length]!.keyframeAuStart).toBe(true)
    expect(flags.every((f) => f.keyframeAu)).toBe(true)
  })
})

// ── RTSP restream: the backlog latch counts PICTURES ─────────────────

afterEach(destroyMockSockets)

/** Feed source RTP into the restreamer with the flags the broker now computes. */
function feedRestreamer(
  restreamer: RtspRestreamer,
  depacketizer: RtpDepacketizer,
  tracker: RtpAccessUnitTracker,
  packets: readonly Buffer[],
): void {
  for (const p of packets) {
    const carried = depacketizer.processPacket(p)
    const flags = carried ? tracker.classify(carried) : null
    restreamer.pushRtpPassthrough(p, flags?.keyframeAu ?? false, flags?.parameterSet ?? false)
  }
}

describe('RtspRestreamer — a backlogged session misses KEYFRAME PICTURES, not IRAP packets', () => {
  it('counts one missed keyframe per IDR picture: closed on the third GOP, not inside the first', () => {
    const restreamer = new RtspRestreamer('test-stream')
    restreamer.setCameraSdp(H265_SDP, 'h265', null)
    const depacketizer = new RtpDepacketizer('h265', () => {})
    const tracker = new RtpAccessUnitTracker()

    const mock = createMockSocket()
    playSession(restreamer, mock)

    // Join at the live edge on a clean GOP: the first GOP streams normally.
    let state = { seq: 1, timestamp: 0 }
    const stream = (): void => {
      const g = gop({
        codec: 'h265',
        seq: state.seq,
        timestamp: state.timestamp,
        stepTicks: TICKS_25FPS,
        slicesPerPicture: 3,
        pFrames: 4,
        packaging: 'fu',
      })
      feedRestreamer(restreamer, depacketizer, tracker, g.packets)
      state = { seq: g.nextSeq, timestamp: g.nextTimestamp }
    }
    stream()
    expect(mock.written.length).toBeGreaterThan(0)

    // The socket stops draining. Each following GOP opens with a 12-packet
    // keyframe picture (3 params + 3 IRAP slices × 3 fragments): per-packet
    // counting would reach MAX_MISSED_KEYFRAMES (3) inside the FIRST of them.
    mock.setBacklogged(true)
    for (let missed = 1; missed < MAX_MISSED_KEYFRAMES; missed++) {
      stream()
      expect(mock.destroy).not.toHaveBeenCalled()
    }
    stream()
    expect(mock.destroy).toHaveBeenCalledTimes(1)
  })

  it('the keyframe cache keeps the WHOLE fragmented picture for a late joiner, parameter sets first', () => {
    vi.useFakeTimers()
    try {
      const restreamer = new RtspRestreamer('test-stream')
      restreamer.setCameraSdp(H265_SDP, 'h265', null)
      const depacketizer = new RtpDepacketizer('h265', () => {})
      const tracker = new RtpAccessUnitTracker()

      // Keyframe picture then one P picture — the cache latch has closed.
      const g = gop({
        codec: 'h265',
        seq: 1,
        timestamp: 0,
        stepTicks: TICKS_25FPS,
        slicesPerPicture: 3,
        pFrames: 1,
        packaging: 'fu',
        withPrefixSei: true,
      })
      feedRestreamer(restreamer, depacketizer, tracker, g.packets)

      // A late joiner with a cold ring is primed from the cached keyframe AU.
      const mock = createMockSocket()
      playSession(restreamer, mock)
      const tail = picture({
        codec: 'h265',
        seq: g.nextSeq,
        timestamp: g.nextTimestamp,
        withParams: false,
        keyframe: false,
        slices: 3,
        packaging: 'fu',
      })
      feedRestreamer(restreamer, depacketizer, tracker, tail.packets)
      vi.advanceTimersByTime(2_000)

      const keyframePackets = g.pictures[0]!.packets
      const frames = countRtpFrames(mock.written)
      // The prime is the entire keyframe picture (13 packets), then the live tail.
      expect(frames).toBe(keyframePackets.length + tail.packets.length)
      const firstPayload = mock.written[1]!
      expect(firstPayload).toEqual(keyframePackets[0])
    } finally {
      vi.useRealTimers()
    }
  })
})
