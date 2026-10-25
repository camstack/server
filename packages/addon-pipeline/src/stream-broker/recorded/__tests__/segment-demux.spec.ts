import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { demuxSegmentToAnnexB } from '../segment-demux'

// Integration test: exercises the real ffmpeg subprocess remux (`.m4s` →
// mpegts) + the pure TS parser end-to-end against a real HEVC recording
// fragment. Requires ffmpeg on PATH (present on dev + hub + agent images).
const SAMPLE = readFileSync(join(__dirname, 'fixtures/sample.m4s'))
/** The binary the product would run: CI exports the pinned build here (D540). */
const FFMPEG = process.env['CAMSTACK_FFMPEG_PATH'] ?? 'ffmpeg'
const NAL_TYPE = (b: Buffer, start: number): number => (b[start]! >> 1) & 0x3f // HEVC

describe('demuxSegmentToAnnexB (ffmpeg mpegts remux)', () => {
  it('yields at least one access unit', async () => {
    const aus = await demuxSegmentToAnnexB(new Uint8Array(SAMPLE), FFMPEG)
    expect(aus.length).toBeGreaterThan(0)
  })
  it('reports codec H265 for the real HEVC fixture', async () => {
    const aus = await demuxSegmentToAnnexB(new Uint8Array(SAMPLE), FFMPEG)
    expect(aus.every((au) => au.codec === 'H265')).toBe(true)
  })
  it('the first AU is an IDR led by VPS/SPS/PPS (Annex-B start codes present)', async () => {
    const aus = await demuxSegmentToAnnexB(new Uint8Array(SAMPLE), FFMPEG)
    const first = Buffer.from(aus[0]!.data)
    expect(first.subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, 1]))
    const types = new Set<number>()
    for (let i = 0; i + 4 < first.length; i++) {
      if (first[i] === 0 && first[i + 1] === 0 && first[i + 2] === 0 && first[i + 3] === 1)
        types.add(NAL_TYPE(first, i + 4))
    }
    expect(types.has(32)).toBe(true) // VPS
    expect(types.has(33)).toBe(true) // SPS
    expect(types.has(34)).toBe(true) // PPS
    expect(types.has(19) || types.has(20)).toBe(true) // IDR
  })
  it('exactly one keyframe (single-GOP fragment), and it is the first AU', async () => {
    const aus = await demuxSegmentToAnnexB(new Uint8Array(SAMPLE), FFMPEG)
    expect(aus[0]!.keyframe).toBe(true)
    expect(aus.filter((au) => au.keyframe).length).toBe(1)
  })
  it('access units carry monotonically non-decreasing source pts (ms)', async () => {
    const aus = await demuxSegmentToAnnexB(new Uint8Array(SAMPLE), FFMPEG)
    for (let i = 1; i < aus.length; i++)
      expect(aus[i]!.ptsMs).toBeGreaterThanOrEqual(aus[i - 1]!.ptsMs)
  })
})
