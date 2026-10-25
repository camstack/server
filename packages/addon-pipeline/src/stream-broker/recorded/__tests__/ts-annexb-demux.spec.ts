import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { demuxMpegTsToAnnexB, codecForStreamType } from '../ts-annexb-demux'

// A real HEVC+AAC transport stream produced from the recorder's sample .m4s via
// `ffmpeg -map 0:v:0 -c:v copy -f mpegts` — the exact intermediate segment-demux
// now hands this parser. Hermetic: no ffmpeg/native binding at test time.
const TS = new Uint8Array(readFileSync(join(__dirname, 'fixtures/sample.mpegts')))
const HEVC_NAL_TYPE = (b: Uint8Array, start: number): number => (b[start]! >> 1) & 0x3f

describe('codecForStreamType', () => {
  it('maps 0x1b → H264 and 0x24 → H265', () => {
    expect(codecForStreamType(0x1b)).toBe('H264')
    expect(codecForStreamType(0x24)).toBe('H265')
  })
  it('returns null for a non-video stream_type', () => {
    expect(codecForStreamType(0x0f)).toBeNull() // AAC audio
  })
})

describe('demuxMpegTsToAnnexB', () => {
  it('reports codec H265 for the real HEVC transport stream', () => {
    expect(demuxMpegTsToAnnexB(TS).codec).toBe('H265')
  })

  it('yields one access unit per video frame', () => {
    // The source fixture is a single ~4 s GOP of 40 frames.
    expect(demuxMpegTsToAnnexB(TS).accessUnits.length).toBe(40)
  })

  it('exactly one keyframe, and it is the first AU', () => {
    const { accessUnits } = demuxMpegTsToAnnexB(TS)
    expect(accessUnits[0]!.keyframe).toBe(true)
    expect(accessUnits.filter((au) => au.keyframe).length).toBe(1)
  })

  it('the first AU is an IDR fused with VPS/SPS/PPS (Annex-B start codes present)', () => {
    const first = demuxMpegTsToAnnexB(TS).accessUnits[0]!.data
    expect(Array.from(first.subarray(0, 4))).toEqual([0, 0, 0, 1])
    const types = new Set<number>()
    for (let i = 0; i + 4 < first.length; i++) {
      if (first[i] === 0 && first[i + 1] === 0 && first[i + 2] === 0 && first[i + 3] === 1)
        types.add(HEVC_NAL_TYPE(first, i + 4))
    }
    expect(types.has(32)).toBe(true) // VPS
    expect(types.has(33)).toBe(true) // SPS
    expect(types.has(34)).toBe(true) // PPS
    expect(types.has(19) || types.has(20)).toBe(true) // IDR
  })

  it('access units carry monotonically non-decreasing PTS (ms)', () => {
    const { accessUnits } = demuxMpegTsToAnnexB(TS)
    for (let i = 1; i < accessUnits.length; i++)
      expect(accessUnits[i]!.ptsMs).toBeGreaterThanOrEqual(accessUnits[i - 1]!.ptsMs)
  })

  it('throws when no video elementary stream is present', () => {
    // A lone null-packet (PID 0x1FFF) stream has no PAT/PMT → no video.
    const nullPkt = new Uint8Array(188).fill(0xff)
    nullPkt[0] = 0x47
    nullPkt[1] = 0x1f
    nullPkt[2] = 0xff
    expect(() => demuxMpegTsToAnnexB(nullPkt)).toThrow(/no H.264\/H.265 video stream/)
  })
})
