import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { demuxSegmentToPcmu, sliceMuLawToPcmuFrames } from '../segment-audio'

const SAMPLE = readFileSync(join(__dirname, 'fixtures/sample.m4s'))
/** The binary the product would run: CI exports the pinned build here (D540). */
const FFMPEG = process.env['CAMSTACK_FFMPEG_PATH'] ?? 'ffmpeg'

describe('sliceMuLawToPcmuFrames', () => {
  it('slices into 160-byte / 20 ms frames with running ptsMs', () => {
    const frames = sliceMuLawToPcmuFrames(new Uint8Array(160 * 3))
    expect(frames.length).toBe(3)
    expect(frames.map((f) => f.data.length)).toEqual([160, 160, 160])
    expect(frames.map((f) => f.ptsMs)).toEqual([0, 20, 40])
  })
  it('drops a trailing partial frame (< 160 samples)', () => {
    expect(sliceMuLawToPcmuFrames(new Uint8Array(160 + 80)).length).toBe(1)
  })
  it('returns [] for empty input', () => {
    expect(sliceMuLawToPcmuFrames(new Uint8Array(0))).toEqual([])
  })
})

describe('demuxSegmentToPcmu (ffmpeg AAC → 8 kHz µ-law)', () => {
  it('produces 20 ms PCMU frames from the fixture AAC audio', async () => {
    const frames = await demuxSegmentToPcmu(new Uint8Array(SAMPLE), FFMPEG)
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every((f) => f.data.length === 160)).toBe(true)
    // ~4 s of audio → frames advance by 20 ms and are strictly increasing.
    for (let i = 1; i < frames.length; i++) expect(frames[i]!.ptsMs).toBe(frames[i - 1]!.ptsMs + 20)
  })
})
