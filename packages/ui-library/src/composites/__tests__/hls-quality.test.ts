import { describe, it, expect } from 'vitest'
import { qualityOptions, levelLabel, type HlsLevelInfo } from '../hls-quality'

describe('levelLabel', () => {
  it('prefers the profile name even when height is present', () => {
    // The recorder stamps the master variant NAME with the recording profile
    // (high/mid/low); the selector must show that, NOT a resolution — it has to
    // match the live stream-profile selector's labels.
    const level: HlsLevelInfo = { height: 1080, bitrate: 4_000_000, name: 'high' }
    expect(levelLabel(level, 0)).toBe('high')
  })

  it('uses height when no name is present', () => {
    const level: HlsLevelInfo = { height: 1080, bitrate: 4_000_000 }
    expect(levelLabel(level, 0)).toBe('1080p')
  })

  it('falls back to name when height is absent', () => {
    const level: HlsLevelInfo = { name: 'high', bitrate: 3_000_000 }
    expect(levelLabel(level, 0)).toBe('high')
  })

  it('falls back to name when height is 0 (unknown)', () => {
    const level: HlsLevelInfo = { height: 0, name: 'medium' }
    expect(levelLabel(level, 1)).toBe('medium')
  })

  it('falls back to kbps label when no height or name', () => {
    const level: HlsLevelInfo = { bitrate: 2_500_000 }
    expect(levelLabel(level, 0)).toBe('2500 kbps')
  })

  it('rounds bitrate to nearest kbps', () => {
    const level: HlsLevelInfo = { bitrate: 1_499_000 }
    expect(levelLabel(level, 0)).toBe('1499 kbps')
  })

  it('falls back to Level N (1-based) when all fields absent', () => {
    const level: HlsLevelInfo = {}
    expect(levelLabel(level, 0)).toBe('Level 1')
    expect(levelLabel(level, 2)).toBe('Level 3')
  })

  it('ignores empty name string', () => {
    const level: HlsLevelInfo = { name: '', bitrate: 1_000_000 }
    expect(levelLabel(level, 0)).toBe('1000 kbps')
  })
})

describe('qualityOptions', () => {
  it('always starts with Auto (value: -1) even when levels is empty', () => {
    const opts = qualityOptions([])
    expect(opts).toHaveLength(1)
    expect(opts[0]).toStrictEqual({ value: -1, label: 'Auto' })
  })

  it('returns Auto + one entry per level', () => {
    const levels: HlsLevelInfo[] = [
      { height: 1080, bitrate: 4_000_000 },
      { height: 720, bitrate: 2_000_000 },
    ]
    const opts = qualityOptions(levels)
    expect(opts).toHaveLength(3)
    expect(opts[0]).toStrictEqual({ value: -1, label: 'Auto' })
    expect(opts[1]).toStrictEqual({ value: 0, label: '1080p' })
    expect(opts[2]).toStrictEqual({ value: 1, label: '720p' })
  })

  it('assigns level index as value (0-based), Auto is -1', () => {
    const levels: HlsLevelInfo[] = [
      { bitrate: 1_000_000 },
      { bitrate: 3_000_000 },
      { bitrate: 6_000_000 },
    ]
    const opts = qualityOptions(levels)
    expect(opts.map((o) => o.value)).toStrictEqual([-1, 0, 1, 2])
  })

  it('uses levelLabel for each level entry', () => {
    const levels: HlsLevelInfo[] = [{ height: 480 }]
    const opts = qualityOptions(levels)
    expect(opts[1]?.label).toBe('480p')
  })

  it('does not mutate the input array', () => {
    const levels: HlsLevelInfo[] = [{ height: 720 }]
    const original = [...levels]
    qualityOptions(levels)
    expect(levels).toStrictEqual(original)
  })
})
