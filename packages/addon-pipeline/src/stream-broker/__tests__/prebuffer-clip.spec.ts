import type { EncodedPacket } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  clipFfmpegArgs,
  pickClipProfile,
  tailWindow,
  toElementaryStream,
  windowAround,
} from '../stream-broker/prebuffer-clip.js'

const base: EncodedPacket = {
  type: 'video',
  data: Buffer.alloc(0),
  pts: 0,
  dts: 0,
  keyframe: false,
  codec: 'h264',
}

const pkt = (pts: number, over: Partial<EncodedPacket> = {}): EncodedPacket => ({
  type: 'video',
  data: Buffer.from([pts & 0xff]),
  pts,
  dts: pts,
  keyframe: false,
  codec: 'h264',
  ...over,
})

describe('pickClipProfile', () => {
  // A notification attachment is watched on a phone; spending the 4K rendition
  // on it burns CPU to produce a file the client downscales anyway.
  it('defaults to the CHEAPEST assigned profile', () => {
    expect(pickClipProfile(['high', 'mid', 'low'], undefined)).toBe('low')
    expect(pickClipProfile(['high', 'mid'], undefined)).toBe('mid')
    expect(pickClipProfile(['high'], undefined)).toBe('high')
  })

  it('honours an explicit choice when that profile is assigned', () => {
    expect(pickClipProfile(['high', 'low'], 'high')).toBe('high')
  })

  // Silently rendering a DIFFERENT profile than asked would be worse: falling
  // back to the cheapest is visible in the response, which reports what ran.
  it('falls back to the cheapest when the requested profile is not assigned', () => {
    expect(pickClipProfile(['low'], 'high')).toBe('low')
  })

  it('is null when the camera has no assigned profile at all', () => {
    expect(pickClipProfile([], 'low')).toBeNull()
  })
})

describe('tailWindow', () => {
  it('returns the last windowSec, starting at a KEYFRAME', () => {
    const packets = [
      pkt(0, { keyframe: true }),
      pkt(1000),
      pkt(2000, { keyframe: true }),
      pkt(3000),
      pkt(4000),
    ]
    const out = tailWindow(packets, 2)
    expect(out[0]?.keyframe).toBe(true)
    expect(out[0]?.pts).toBe(2000)
    expect(out).toHaveLength(3)
  })

  // A window that begins mid-GOP is undecodable; widening backwards costs a
  // little extra footage and is the only thing that plays.
  it('widens backwards to the previous keyframe rather than cutting mid-GOP', () => {
    const packets = [pkt(0, { keyframe: true }), pkt(1000), pkt(2000), pkt(3000)]
    const out = tailWindow(packets, 1)
    expect(out[0]?.pts).toBe(0)
  })

  it('DROPS placeholder packets — a different parameter set freezes the decode', () => {
    const packets = [
      pkt(0, { keyframe: true, isPlaceholder: true }),
      pkt(1000, { keyframe: true }),
      pkt(2000),
    ]
    const out = tailWindow(packets, 10)
    expect(out.every((p) => p.isPlaceholder !== true)).toBe(true)
    expect(out[0]?.pts).toBe(1000)
  })

  it('is empty when there is no keyframe to start from', () => {
    expect(tailWindow([pkt(0), pkt(1000)], 5)).toHaveLength(0)
  })

  it('ignores audio packets', () => {
    const out = tailWindow([pkt(0, { keyframe: true }), pkt(500, { type: 'audio' })], 5)
    expect(out.every((p) => p.type === 'video')).toBe(true)
  })
})

describe('clipFfmpegArgs', () => {
  it('reads annex-B h264 from stdin and writes to stdout', () => {
    const args = clipFfmpegArgs({ format: 'gif', maxWidth: 480, fps: 5 })
    expect(args).toContain('pipe:0')
    expect(args[args.length - 1]).toBe('pipe:1')
    expect(args.join(' ')).toContain('-f h264')
  })

  // A normal mp4 rewrites its header at the end, which a PIPE cannot do — the
  // file would arrive unplayable.
  it('mp4 to a pipe must be fragmented', () => {
    const args = clipFfmpegArgs({ format: 'mp4', maxWidth: 640, fps: 5 })
    expect(args.join(' ')).toContain('frag_keyframe+empty_moov')
  })

  it('gif decimates with fps, mp4 keeps the source cadence', () => {
    expect(clipFfmpegArgs({ format: 'gif', maxWidth: 480, fps: 4 }).join(' ')).toContain('fps=4')
    expect(clipFfmpegArgs({ format: 'mp4', maxWidth: 480, fps: 4 }).join(' ')).not.toContain('fps=')
  })

  // ── quality: a GIF is 256 colours, and WHICH 256 is the whole game ──
  //
  // Without a palette pass ffmpeg quantises to a fixed generic palette, which
  // is why the output looked banded and washed out on exactly the content a
  // camera produces — large areas of near-identical tone. `palettegen` builds
  // the palette from THIS clip's own colours; `paletteuse` maps to it.
  it('gif builds a palette from the clip instead of quantising to a generic one', () => {
    const args = clipFfmpegArgs({ format: 'gif', maxWidth: 480, fps: 5 }).join(' ')
    expect(args).toContain('palettegen')
    expect(args).toContain('paletteuse')
  })

  it('mp4 gets no palette pass — it is not a paletted format', () => {
    const args = clipFfmpegArgs({ format: 'mp4', maxWidth: 480, fps: 5 }).join(' ')
    expect(args).not.toContain('palettegen')
  })

  // ── speed ────────────────────────────────────────────────────────────
  it('speeds the GIF up by default — a notification clip is glanced at, not watched', () => {
    const args = clipFfmpegArgs({ format: 'gif', maxWidth: 480, fps: 5 }).join(' ')
    expect(args).toContain('setpts=PTS/2')
  })

  it('honours an operator-chosen speed', () => {
    expect(clipFfmpegArgs({ format: 'gif', maxWidth: 480, fps: 5, speed: 4 }).join(' ')).toContain(
      'setpts=PTS/4',
    )
  })

  it('1x means real time, and emits no setpts at all', () => {
    const args = clipFfmpegArgs({ format: 'gif', maxWidth: 480, fps: 5, speed: 1 }).join(' ')
    expect(args).not.toContain('setpts')
  })

  it('speeds an MP4 too — the operator set a speed, not a GIF speed', () => {
    expect(clipFfmpegArgs({ format: 'mp4', maxWidth: 480, fps: 5, speed: 2 }).join(' ')).toContain(
      'setpts=PTS/2',
    )
  })

  it('decimates BEFORE speeding up, so the frame rate is the one asked for', () => {
    // `setpts` after `fps` — reversing them makes the requested fps apply to
    // the sped-up timeline and silently doubles the frame count.
    const vf = clipFfmpegArgs({ format: 'gif', maxWidth: 480, fps: 5, speed: 2 }).join(' ')
    expect(vf.indexOf('fps=5')).toBeLessThan(vf.indexOf('setpts'))
  })

  it('RE-DECLARES the rate after setpts, or the muxer throws the speed-up away', () => {
    // Measured on a live 101 window: `setpts` rewrites the timestamps but the
    // filter link goes on advertising the DECIMATION rate, and the gif muxer
    // believes the link — so a 4× gif came out the right length with a quarter
    // of the frames it should have had, and BIGGER, because frames that far
    // apart share nothing for the gif's inter-frame transparency to delta away.
    const vf = clipFfmpegArgs({ format: 'gif', maxWidth: 480, fps: 3, speed: 4 }).join(' ')
    expect(vf).toContain('fps=3,setpts=PTS/4,fps=12,')
  })

  it('re-declares nothing at real time — one fps is already the whole answer', () => {
    const vf = clipFfmpegArgs({ format: 'gif', maxWidth: 480, fps: 5, speed: 1 }).join(' ')
    expect(vf).toContain('[0:v]fps=5,scale=')
  })
})

describe('windowAround', () => {
  // 10 s of packets at 2 Hz, keyframe every 2 s. pts is a stream clock with an
  // arbitrary origin — deliberately NOT wall time.
  const packets = Array.from({ length: 20 }, (_, i) =>
    pkt(500_000 + i * 500, { keyframe: i % 4 === 0 }),
  )
  const nowMs = 1_700_000_000_000
  const newestWall = nowMs
  const oldestWall = newestWall - 19 * 500

  it('CENTRES the cut on the moment, not on the tail of the buffer', () => {
    const around = newestWall - 4_000
    const out = windowAround({ packets, aroundMs: around, preRollSec: 2, postRollSec: 2, nowMs })
    expect(out.length).toBeGreaterThan(0)
    const first = out[0]
    const last = out[out.length - 1]
    const newestPts = packets[packets.length - 1]!.pts
    const wallOf = (pts: number): number => nowMs - (newestPts - pts)
    // Both sides of the moment are present…
    expect(wallOf(first!.pts)).toBeLessThanOrEqual(around)
    expect(wallOf(last!.pts)).toBeGreaterThanOrEqual(around)
    // …and the cut does NOT run to the end of the buffer.
    expect(last!.pts).toBeLessThan(newestPts)
  })

  // The failure the operator reported for the segment-sourced version: a clip
  // that plays the present instead of the event it announces.
  it('a LATE call still yields the event, not the newest seconds', () => {
    const around = newestWall - 8_000
    const out = windowAround({ packets, aroundMs: around, preRollSec: 1, postRollSec: 1, nowMs })
    const newestPts = packets[packets.length - 1]!.pts
    const last = out[out.length - 1]!
    expect(newestPts - last.pts).toBeGreaterThan(5_000)
  })

  it('starts at a KEYFRAME even when the moment lands mid-GOP', () => {
    const out = windowAround({
      packets,
      aroundMs: newestWall - 3_250,
      preRollSec: 0,
      postRollSec: 1,
      nowMs,
    })
    expect(out[0]?.keyframe).toBe(true)
  })

  it('is EMPTY when the ring no longer reaches back to the moment', () => {
    const out = windowAround({
      packets,
      aroundMs: oldestWall - 30_000,
      preRollSec: 2,
      postRollSec: 2,
      nowMs,
    })
    expect(out).toHaveLength(0)
  })

  it('is EMPTY when the moment is still in the future (post-roll not waited out)', () => {
    const out = windowAround({
      packets,
      aroundMs: newestWall + 5_000,
      preRollSec: 2,
      postRollSec: 2,
      nowMs,
    })
    expect(out).toHaveLength(0)
  })

  it('drops placeholder packets here too', () => {
    const withPlaceholders = [pkt(499_000, { keyframe: true, isPlaceholder: true }), ...packets]
    const out = windowAround({
      packets: withPlaceholders,
      aroundMs: newestWall - 4_000,
      preRollSec: 10,
      postRollSec: 2,
      nowMs,
    })
    expect(out.every((p) => p.isPlaceholder !== true)).toBe(true)
  })
})

describe('toElementaryStream', () => {
  const startCode = Buffer.from([0, 0, 0, 1])
  const annexB = (body: number[]): Buffer => Buffer.concat([startCode, Buffer.from(body)])

  // The failure this exists for: broker packets are not guaranteed Annex-B.
  // Several sources carry length-prefixed access units, which ffmpeg's `-f
  // h264` demuxer parses into NOTHING — it exits "received no packets" and the
  // notification silently ships without its clip.
  it('converts LENGTH-PREFIXED access units to Annex-B', () => {
    const nal = Buffer.from([0x65, 0xaa, 0xbb])
    const avcc = Buffer.concat([Buffer.from([0, 0, 0, nal.length]), nal])
    const out = toElementaryStream([{ ...base, data: avcc, keyframe: true }])
    expect(out.subarray(0, 4)).toEqual(startCode)
    expect(out.subarray(4)).toEqual(nal)
  })

  it('passes Annex-B through untouched', () => {
    const data = annexB([0x65, 0x01])
    const out = toElementaryStream([{ ...base, data, keyframe: true }])
    expect(out).toEqual(data)
  })

  // Reolink native high ships SPS/PPS only in the SDP; without them ffmpeg
  // never initialises its decoder.
  it('primes the stream with the SDP parameter sets when the keyframe lacks them', () => {
    const sps = annexB([0x67, 0x42])
    const pps = annexB([0x68, 0xce])
    const idr = annexB([0x65, 0x11])
    const out = toElementaryStream([{ ...base, data: idr, keyframe: true }], [sps, pps])
    expect(out.subarray(0, sps.length + pps.length)).toEqual(Buffer.concat([sps, pps]))
  })

  it('does NOT duplicate parameter sets a camera already carries in-band', () => {
    const sps = annexB([0x67, 0x42])
    const pps = annexB([0x68, 0xce])
    const idr = Buffer.concat([sps, pps, annexB([0x65, 0x11])])
    const out = toElementaryStream([{ ...base, data: idr, keyframe: true }], [sps, pps])
    expect(out).toEqual(idr)
  })

  it('primes ONCE, not before every keyframe', () => {
    const sps = annexB([0x67, 0x42])
    const pps = annexB([0x68, 0xce])
    const idr = annexB([0x65, 0x11])
    const out = toElementaryStream(
      [
        { ...base, data: idr, keyframe: true },
        { ...base, data: idr, keyframe: true },
      ],
      [sps, pps],
    )
    const primer = Buffer.concat([sps, pps])
    expect(out.length).toBe(primer.length + idr.length * 2)
  })
})

describe('clipFfmpegArgs demuxer', () => {
  // A mismatched demuxer decodes nothing — the same silent-empty failure.
  it('reads hevc when the packets are H.265', () => {
    expect(
      clipFfmpegArgs({ format: 'gif', maxWidth: 480, fps: 5, hevc: true }).join(' '),
    ).toContain('-f hevc')
    expect(
      clipFfmpegArgs({ format: 'mp4', maxWidth: 480, fps: 5, hevc: true }).join(' '),
    ).toContain('-f hevc')
  })
})
