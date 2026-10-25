/**
 * `readMp4DurationMs` — the one fact the pacing check needs from the finished
 * file, read from the bytes the artifact publisher already fetches. Kept a
 * byte-walk (never an ffprobe spawn): the check runs on the hub, best-effort,
 * after every scheduled window, and must cost microseconds, not a process.
 */
import { describe, expect, it } from 'vitest'
import { readMp4DurationMs } from '../mp4-duration.js'
import { buildTestMp4 } from './mp4-fixture.js'

describe('readMp4DurationMs', () => {
  it('reads a version-0 mvhd', () => {
    expect(readMp4DurationMs(buildTestMp4({ durationMs: 49_500 }))).toBe(49_500)
  })

  it('reads a version-1 (64-bit) mvhd', () => {
    expect(readMp4DurationMs(buildTestMp4({ durationMs: 123_456, version1: true }))).toBe(123_456)
  })

  it('honours the movie timescale', () => {
    expect(readMp4DurationMs(buildTestMp4({ durationMs: 2_000, timescale: 90_000 }))).toBe(2_000)
  })

  it('answers null for bytes with no moov', () => {
    expect(readMp4DurationMs(new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]))).toBeNull()
  })

  it('answers null for truncated bytes rather than throwing', () => {
    const whole = buildTestMp4({ durationMs: 49_500 })
    expect(readMp4DurationMs(whole.slice(0, whole.length - 6))).toBeNull()
    expect(readMp4DurationMs(new Uint8Array(0))).toBeNull()
    expect(readMp4DurationMs(new Uint8Array([1, 2, 3]))).toBeNull()
  })

  it('answers null for a zero timescale', () => {
    expect(readMp4DurationMs(buildTestMp4({ durationMs: 1_000, timescale: 0 }))).toBeNull()
  })
})
