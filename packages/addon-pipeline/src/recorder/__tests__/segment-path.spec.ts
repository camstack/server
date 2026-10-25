import { describe, it, expect } from 'vitest'
import { segmentRelPath, parseSegmentPath } from '../segment-path.js'

describe('segment-path', () => {
  it('builds a UTC-bucketed relative path with bytes in the filename', () => {
    const p = segmentRelPath(99, 'high', 1781512557000, 2000, 524288)
    expect(p).toBe('99/high/2026/06/15/08/1781512557000-2000-524288.m4s')
  })
  it('round-trips parse(build(...)) including bytes', () => {
    const p = segmentRelPath(7, 'low', 1781512557000, 1987, 12345)
    expect(parseSegmentPath(p)).toEqual({
      deviceId: 7,
      profile: 'low',
      startMs: 1781512557000,
      durMs: 1987,
      bytes: 12345,
    })
  })
  it('returns null for a non-segment path', () => {
    expect(parseSegmentPath('99/high/live.m3u8')).toBeNull()
    expect(parseSegmentPath('99/high/2026/06/15/08/1781512557000-2000.m4s')).toBeNull() // old 2-field name no longer valid
    expect(parseSegmentPath('garbage')).toBeNull()
  })
  it('throws if profile contains a slash', () => {
    expect(() => segmentRelPath(1, 'a/b', 0, 1, 1)).toThrow(/profile must not contain/)
  })
  it('returns null for non-segment dirs under a device/profile (e.g. thumbnails)', () => {
    expect(parseSegmentPath('99/high/thumbnails/x.jpg')).toBeNull()
    expect(parseSegmentPath('99/high/abcd/06/15/08/1000-2000-50.m4s')).toBeNull()
  })
})

describe('segment-path — staging (.rec-tmp) rejection', () => {
  it('rejects staging paths under .rec-tmp (never indexable)', () => {
    // Per-location staging (R1): flat ffmpeg segments under
    // `<root>/.rec-tmp/<dev>/<profile>/` must NEVER parse as finalized segments.
    expect(parseSegmentPath('.rec-tmp/99/high/1781512557.m4s')).toBeNull()
    expect(
      parseSegmentPath('.rec-tmp/99/high/2026/06/15/08/1781512557000-2000-524288.m4s'),
    ).toBeNull()
  })
})
