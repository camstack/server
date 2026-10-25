/**
 * ONE duration format for the product.
 *
 * This is `RecordingPanel`'s own formatter, promoted rather than copied: the
 * library had three private `formatDuration`s already (the config-field one,
 * which is about a config VALUE and says `ms` and `—`; the scene-monitor
 * `humanDuration`, which is single-unit and coarse) and a clip length is the
 * same question the recording panel was already answering. A fourth copy is
 * how "the way the product formats a duration" stops being a fact.
 *
 * The cases below are the real range of one camera-day on 107 (2026-09-20):
 * 400 clips, min 2 s, median 34 s, max 220 s.
 */
import { describe, expect, it } from 'vitest'
import { formatDurationMs } from '../format-duration.js'

describe('formatDurationMs', () => {
  it('formats the range a clip list really holds', () => {
    expect(formatDurationMs(2_000)).toBe('2s')
    expect(formatDurationMs(34_000)).toBe('34s')
    expect(formatDurationMs(220_000)).toBe('3m 40s')
  })

  it('drops to hours and minutes once seconds stop being the story', () => {
    expect(formatDurationMs(3_600_000)).toBe('1h 0m')
    expect(formatDurationMs(5_400_000)).toBe('1h 30m')
  })

  it('rounds to the nearest second rather than truncating', () => {
    expect(formatDurationMs(1_600)).toBe('2s')
    expect(formatDurationMs(0)).toBe('0s')
  })

  it('is byte-for-byte what the recording panel already showed', () => {
    // The promoted body, exercised on the values that panel renders: a
    // retention window in days and a short span. If this drifts, the panel
    // changed silently and the promotion was not behaviour-neutral.
    expect(formatDurationMs(24 * 60 * 60 * 1000)).toBe('24h 0m')
    expect(formatDurationMs(90_000)).toBe('1m 30s')
  })
})
