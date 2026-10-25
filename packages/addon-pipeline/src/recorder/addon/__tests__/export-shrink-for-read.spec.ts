/**
 * The argv / CRF ladder that turns an oversized export into an inline-sized
 * notification body. Pure — no ffmpeg on the machine running the suite.
 */
import { describe, expect, it } from 'vitest'
import {
  buildExportShrinkArgs,
  EXPORT_SHRINK_CRF_LADDER,
  nextShrinkCrf,
} from '../export-shrink-for-read.js'

describe('buildExportShrinkArgs', () => {
  it('re-encodes to 640p h264 without audio, with faststart', () => {
    const args = buildExportShrinkArgs({
      inputPath: '/exports/1/a.mp4',
      outputPath: '/tmp/a.crf28.mp4',
      crf: 28,
    })
    expect(args).toContain('/exports/1/a.mp4')
    expect(args).toContain('/tmp/a.crf28.mp4')
    expect(args).toContain('libx264')
    expect(args).toContain('scale=640:-2')
    expect(args).toContain('-an')
    expect(args).toContain('+faststart')
    expect(args).toContain('28')
  })
})

describe('nextShrinkCrf', () => {
  it('walks the ladder then stops', () => {
    const attempted: number[] = []
    for (const want of EXPORT_SHRINK_CRF_LADDER) {
      const next = nextShrinkCrf(attempted)
      expect(next).toBe(want)
      attempted.push(want)
    }
    expect(nextShrinkCrf(attempted)).toBeNull()
  })
})
