import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { indexClipMp4 } from '../clip-mp4-index'
import { buildMp4Fixture, FASTSTART_CLIP, HKSV_CLIP } from './mp4-fixture'

// Real `ffmpeg -movflags +faststart` output, cross-checking the parser against
// a file this repo did not build. LOCAL-ONLY (binary, regenerable):
//   ffmpeg -f lavfi -i "testsrc=size=160x120:rate=15:duration=2" \
//     -c:v libx264 -g 15 -pix_fmt yuv420p -movflags +faststart clip-faststart.mp4
const REAL_FASTSTART = join(__dirname, 'fixtures/clip-faststart.mp4')
const REAL_FRAGMENTED = join(__dirname, 'fixtures/clip-frag.mp4')

describe('indexClipMp4', () => {
  it('indexes a progressive +faststart clip: duration, samples, sync samples', () => {
    const result = indexClipMp4(buildMp4Fixture(FASTSTART_CLIP))
    expect(result.kind).toBe('index')
    if (result.kind !== 'index') return
    // 30 samples at 1000/15000 s = 66.67 ms each ⇒ 2000 ms.
    expect(result.durationMs).toBe(2000)
    expect(result.samples).toHaveLength(30)
    expect(result.syncSampleCount).toBe(2)
    expect(result.samples[0]).toEqual({ startMs: 0, durMs: 1000 / 15, sync: true })
    expect(result.samples[15]?.sync).toBe(true)
    expect(result.samples[1]?.sync).toBe(false)
    // The last sample ends exactly at the duration — the file-relative
    // timeline's upper bound, which is what `ended` is decided on.
    const last = result.samples[29]
    expect(last).toBeDefined()
    if (last) expect(last.startMs + last.durMs).toBeCloseTo(2000, 6)
  })

  it('reports the FIRST sync sample time, so a seek before it snaps forward', () => {
    const result = indexClipMp4(buildMp4Fixture({ ...FASTSTART_CLIP, stss: [4] }))
    expect(result.kind).toBe('index')
    if (result.kind !== 'index') return
    expect(result.firstSyncMs).toBeCloseTo(3 * (1000 / 15), 6)
  })

  it('treats a missing stss as "every sample is a sync sample" (ISO 14496-12)', () => {
    const result = indexClipMp4(buildMp4Fixture({ ...FASTSTART_CLIP, stss: null }))
    expect(result.kind).toBe('index')
    if (result.kind !== 'index') return
    expect(result.syncSampleCount).toBe(30)
    expect(result.firstSyncMs).toBe(0)
  })

  it('REFUSES an HKSV-shaped clip by name: zero duration, no sample table', () => {
    const result = indexClipMp4(buildMp4Fixture(HKSV_CLIP))
    expect(result.kind).toBe('refused')
    if (result.kind !== 'refused') return
    expect(result.reason).toBe('no-samples')
  })

  it('REFUSES a file whose sample table exists but whose duration is zero', () => {
    const result = indexClipMp4(
      buildMp4Fixture({ ...FASTSTART_CLIP, movieDuration: 0, mediaDuration: 0, stts: [] }),
    )
    expect(result.kind).toBe('refused')
    if (result.kind !== 'refused') return
    expect(result.reason).toBe('no-samples')
  })

  it('REFUSES a file with no moov at all', () => {
    expect(indexClipMp4(new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]))).toEqual({
      kind: 'refused',
      reason: 'no-moov',
    })
  })

  it('REFUSES a moov whose only track is not video', () => {
    const result = indexClipMp4(buildMp4Fixture({ ...FASTSTART_CLIP, handlerType: 'soun' }))
    expect(result.kind).toBe('refused')
    if (result.kind !== 'refused') return
    expect(result.reason).toBe('no-video-track')
  })

  it('REFUSES truncated bytes instead of throwing', () => {
    const whole = buildMp4Fixture(FASTSTART_CLIP)
    const result = indexClipMp4(whole.subarray(0, 40))
    expect(result.kind).toBe('refused')
  })

  it('indexes a REAL ffmpeg +faststart file — the cross-check against hand-built boxes', () => {
    const result = indexClipMp4(new Uint8Array(readFileSync(REAL_FASTSTART)))
    expect(result.kind).toBe('index')
    if (result.kind !== 'index') return
    expect(result.durationMs).toBeCloseTo(2000, 0)
    expect(result.samples.length).toBe(30)
    expect(result.syncSampleCount).toBeGreaterThanOrEqual(2)
  })

  it('REFUSES a REAL fragmented (empty_moov) file — the HKSV shape', () => {
    const result = indexClipMp4(new Uint8Array(readFileSync(REAL_FRAGMENTED)))
    expect(result.kind).toBe('refused')
    if (result.kind !== 'refused') return
    expect(result.reason).toBe('no-samples')
  })
})
