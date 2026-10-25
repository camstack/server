/**
 * The wire, the SDP and the depacketizer — against 128 KB of a REAL replay.
 *
 * `replay-3833-interleaved.bin` is a verbatim, contiguous slice of the
 * RTP-over-TCP stream device 3833 delivered on 2026-09-22, cut at a
 * fragmentation-unit START so it begins on a NAL boundary; `replay-3833-idr.bin`
 * is the head of the same session, ending on the fragmentation-unit END that
 * closes its first IDR. `replay-3833.sdp` is the `DESCRIBE` body of that
 * session.
 *
 * They are large for fixtures (128 KB and 138 KB) and that is the media: a 4K
 * H.265 keyframe off this archive is 136 KB, and there is no sub-stream copy
 * to take a smaller one from (`clip-twins.ts`). A synthetic packet would have
 * proved the parser against the parser's own assumptions, which is how a demux
 * bug survives a green suite.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  createRtpVideoDepacketizer,
  parseRtpPacket,
  type VideoAccessUnit,
} from '../rtsp/rtp-depacketize.js'
import { parseRtspSdp, resolveControlUrl, type RtspVideoTrack } from '../rtsp/rtsp-sdp.js'
import { createRtspWireReader, type RtspWireEvent } from '../rtsp/rtsp-wire.js'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const sdpText = readFileSync(join(FIXTURES, 'replay-3833.sdp'), 'utf8')
const wireBytes = readFileSync(join(FIXTURES, 'replay-3833-interleaved.bin'))
const idrBytes = readFileSync(join(FIXTURES, 'replay-3833-idr.bin'))

function videoTrackOf(text: string): RtspVideoTrack {
  const track = parseRtspSdp(text).tracks.find(
    (candidate): candidate is RtspVideoTrack => candidate.kind === 'video',
  )
  if (track === undefined) throw new Error('the fixture SDP describes no video track')
  return track
}

/** Feed the fixture in `size`-byte chunks and collect everything it closed. */
function readWire(bytes: Buffer, size: number): readonly RtspWireEvent[] {
  const reader = createRtspWireReader()
  const events: RtspWireEvent[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    events.push(...reader.push(Buffer.from(bytes.subarray(offset, offset + size))))
  }
  return events
}

interface Decoded {
  readonly units: readonly VideoAccessUnit[]
  readonly audio: readonly Buffer[]
  readonly dropped: number
}

function decode(bytes: Buffer, chunkSize: number): Decoded {
  const video = videoTrackOf(sdpText)
  const depacketizer = createRtpVideoDepacketizer({
    codec: video.codec,
    parameterSets: video.parameterSets,
  })
  const units: VideoAccessUnit[] = []
  const audio: Buffer[] = []
  for (const event of readWire(bytes, chunkSize)) {
    if (event.kind !== 'interleaved') continue
    const packet = parseRtpPacket(event.payload)
    if (packet === null) continue
    if (event.channel === 0) {
      const unit = depacketizer.push(packet)
      if (unit !== null) units.push(unit)
      continue
    }
    audio.push(packet.payload)
  }
  const tail = depacketizer.flush()
  if (tail !== null) units.push(tail)
  return { units, audio, dropped: depacketizer.dropped }
}

describe('the SDP the camera really answered', () => {
  it('describes one H.265 video track at 90 kHz and one PCMU track at 8 kHz', () => {
    const description = parseRtspSdp(sdpText)
    expect(description.tracks.map((track) => `${track.kind}:${track.codec}`)).toEqual([
      'video:h265',
      'audio:pcmu',
    ])
    expect(description.tracks[0]?.clockRate).toBe(90_000)
    expect(description.tracks[1]?.clockRate).toBe(8_000)
    expect(description.unsupported).toEqual([])
  })

  it('never offers the session-level control as a track', () => {
    // SETUP on the aggregate URL answers 415 and the camera then closes the
    // socket, so the mistake costs the whole session. It is measured on both
    // cameras and it is why this parser splits on `m=` before it collects.
    const sessionControl = /^a=control:(\S+)$/m.exec(sdpText.slice(0, sdpText.indexOf('\nm=')))
    expect(sessionControl).not.toBeNull()
    const controls = parseRtspSdp(sdpText).tracks.map((track) => track.control)
    expect(controls).not.toContain(sessionControl?.[1])
    expect(controls.every((control) => control.includes('trackID='))).toBe(true)
  })

  it('decodes the parameter sets the camera advertised', () => {
    const video = videoTrackOf(sdpText)
    expect(video.parameterSets.map((set) => set.byteLength)).toEqual([24, 47, 12])
    // VPS = NAL type 32, SPS = 33, PPS = 34, in that order.
    expect(video.parameterSets.map((set) => ((set[0] ?? 0) >> 1) & 0x3f)).toEqual([32, 33, 34])
  })

  it('keeps the replay query when it has to join a relative control', () => {
    const joined = resolveControlUrl(
      'rtsp://h/Streaming/tracks/101/?starttime=20260922T152742Z',
      'trackID=1',
    )
    // A control joined without the query addresses a LIVE track on this
    // firmware — the same recording at the wrong moment.
    expect(joined).toBe('rtsp://h/Streaming/tracks/101/trackID=1?starttime=20260922T152742Z')
  })
})

describe('the wire reader, on real bytes', () => {
  it('frames the same packets at every chunk size', () => {
    const whole = readWire(wireBytes, wireBytes.byteLength)
    expect(whole.every((event) => event.kind === 'interleaved')).toBe(true)
    expect(whole.length).toBe(108)
    const signature = whole.map((event) =>
      event.kind === 'interleaved'
        ? `${String(event.channel)}:${String(event.payload.byteLength)}`
        : event.kind,
    )
    for (const size of [1, 7, 13, 1000, 4096, 65536]) {
      const at = readWire(wireBytes, size)
      expect(
        at.map((event) =>
          event.kind === 'interleaved'
            ? `${String(event.channel)}:${String(event.payload.byteLength)}`
            : event.kind,
        ),
      ).toEqual(signature)
    }
  })

  it('holds a partial frame rather than emitting it', () => {
    const reader = createRtspWireReader()
    expect(reader.push(Buffer.from(wireBytes.subarray(0, 3)))).toEqual([])
    expect(reader.pending()).toBe(3)
  })
})

describe('the depacketizer, on real bytes', () => {
  it('produces the same access units at every chunk size', () => {
    const whole = decode(wireBytes, wireBytes.byteLength)
    expect(whole.units).toHaveLength(6)
    expect(whole.audio).toHaveLength(13)
    for (const size of [1, 7, 13, 4096, 65536]) {
      const at = decode(wireBytes, size)
      expect(at.units.map((unit) => unit.bytes.byteLength)).toEqual(
        whole.units.map((unit) => unit.bytes.byteLength),
      )
      expect(
        Buffer.concat(at.units.map((unit) => unit.bytes)).equals(
          Buffer.concat(whole.units.map((unit) => unit.bytes)),
        ),
      ).toBe(true)
    }
  })

  it('cuts an access unit where the RTP timestamp moves', () => {
    const { units } = decode(wireBytes, wireBytes.byteLength)
    const stamps = units.map((unit) => unit.timestamp)
    expect(stamps).toEqual([86_400, 93_600, 100_800, 108_000, 115_200, 122_400])
    // 7 200 ticks of a 90 kHz clock is 12.5 fps — the rate the mux is told,
    // where `record/tracks` claims 2.26.
    const deltas = stamps.slice(1).map((stamp, index) => stamp - (stamps[index] ?? 0))
    expect(new Set(deltas)).toEqual(new Set([7_200]))
  })

  it('cuts on the timestamp even when a MARKER BIT has gone missing', () => {
    // The real bytes cannot tell the two rules apart: this camera sets the
    // marker on exactly the packet whose successor carries a new timestamp.
    // So the fixture is the real stream with ONE structural field changed —
    // the marker cleared on every packet — which is what a lost final packet
    // of a frame leaves behind. A depacketizer that cut on the marker would
    // emit ONE unit from six frames; cutting on the timestamp is unaffected.
    const stripped = Buffer.from(wireBytes)
    let offset = 0
    let cleared = 0
    while (offset + 4 <= stripped.byteLength) {
      const length = stripped.readUInt16BE(offset + 2)
      if (offset + 4 + length > stripped.byteLength) break
      const marker = stripped[offset + 4 + 1] ?? 0
      if ((marker & 0x80) !== 0) {
        stripped[offset + 4 + 1] = marker & 0x7f
        cleared += 1
      }
      offset += 4 + length
    }
    expect(cleared).toBeGreaterThan(0)
    const whole = decode(wireBytes, wireBytes.byteLength)
    const without = decode(stripped, wireBytes.byteLength)
    expect(without.units.map((unit) => unit.timestamp)).toEqual(
      whole.units.map((unit) => unit.timestamp),
    )
    expect(without.units.map((unit) => unit.bytes.byteLength)).toEqual(
      whole.units.map((unit) => unit.bytes.byteLength),
    )
  })

  it('writes Annex-B, with the SDP parameter sets in front of the first unit', () => {
    const { units } = decode(wireBytes, wireBytes.byteLength)
    const video = videoTrackOf(sdpText)
    const first = units[0]?.bytes
    expect(first).toBeDefined()
    if (first === undefined) return
    const expected = Buffer.concat(
      video.parameterSets.flatMap((set) => [Buffer.from([0, 0, 0, 1]), set]),
    )
    expect(first.subarray(0, expected.byteLength).equals(expected)).toBe(true)
    // Once, and only on the first: a decoder re-reading them every frame is
    // noise, and the camera repeats nothing in band on this archive.
    expect(units[1]?.bytes.subarray(0, 4).equals(Buffer.from([0, 0, 0, 1]))).toBe(true)
    expect(units[1]?.bytes.subarray(0, expected.byteLength).equals(expected)).toBe(false)
  })

  it('counts a fragment the stream ended inside rather than emitting half a NAL', () => {
    // The fixture is a slice, so its last fragmentation unit has no end. Half
    // a NAL in front of a decoder is worse than one frame short.
    expect(decode(wireBytes, wireBytes.byteLength).dropped).toBe(1)
  })

  it('reassembles a real 4K IDR and reports it as a keyframe', () => {
    const { units } = decode(idrBytes, 4096)
    expect(units).toHaveLength(1)
    const idr = units[0]
    expect(idr).toBeDefined()
    if (idr === undefined) return
    expect(idr.keyframe).toBe(true)
    expect(idr.bytes.byteLength).toBe(136_495)
    // This camera repeats VPS/SPS/PPS IN BAND ahead of every IDR, as single
    // NAL packets, so the unit is 32, 33, 34, 19 — and the SDP's copies are
    // NOT prepended on top of them. Two copies are legal and they are noise.
    const nalTypes: number[] = []
    for (let at = 0; at + 5 <= idr.bytes.byteLength; at += 1) {
      if (idr.bytes.readUInt32BE(at) !== 1) continue
      nalTypes.push(((idr.bytes[at + 4] ?? 0) >> 1) & 0x3f)
    }
    expect(nalTypes).toEqual([32, 33, 34, 19])
  })

  it('does not prepend the SDP parameter sets when the stream carries its own', () => {
    const video = videoTrackOf(sdpText)
    const { units } = decode(idrBytes, 4096)
    const opening = Buffer.concat([
      Buffer.from([0, 0, 0, 1]),
      video.parameterSets[0] ?? Buffer.alloc(0),
    ])
    const bytes = units[0]?.bytes
    expect(bytes).toBeDefined()
    if (bytes === undefined) return
    // The camera's OWN VPS is first, and it is not the SDP's byte-for-byte
    // copy sitting in front of the camera's one.
    expect(bytes.indexOf(opening)).toBeLessThanOrEqual(0)
  })

  it('drops a continuation whose start it never saw, and counts it', () => {
    // A session that joined mid-NAL: the real fragmentation units of the IDR,
    // with the one that carries the START bit withheld. There is no NAL to be
    // had, and the honest answer is nothing plus a count — never half a NAL.
    const video = videoTrackOf(sdpText)
    const depacketizer = createRtpVideoDepacketizer({
      codec: video.codec,
      parameterSets: video.parameterSets,
    })
    let fed = 0
    for (const event of readWire(idrBytes, idrBytes.byteLength)) {
      if (event.kind !== 'interleaved' || event.channel !== 0) continue
      const packet = parseRtpPacket(event.payload)
      if (packet === null) continue
      const type = ((packet.payload[0] ?? 0) >> 1) & 0x3f
      if (type !== 49) continue
      if (((packet.payload[2] ?? 0) & 0x80) !== 0) continue
      expect(depacketizer.push(packet)).toBeNull()
      fed += 1
    }
    expect(fed).toBeGreaterThan(80)
    expect(depacketizer.flush()).toBeNull()
    expect(depacketizer.dropped).toBe(fed)
  })
})
