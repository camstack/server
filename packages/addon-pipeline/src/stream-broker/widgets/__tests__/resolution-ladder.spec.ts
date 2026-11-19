import type { EncodeProfile } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { migrateHeightToWidth, resolutionLadder } from '../resolution-ladder'

describe('resolutionLadder', () => {
  it('lists a 16:9 4K source from its own size down to 640x360', () => {
    expect(resolutionLadder({ width: 3840, height: 2160 })).toEqual([
      { width: 3840, height: 2160 },
      { width: 2560, height: 1440 },
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
      { width: 854, height: 480 },
      { width: 640, height: 360 },
    ])
  })

  it('starts at the source size when it is not a standard width', () => {
    const ladder = resolutionLadder({ width: 2688, height: 1520 })
    expect(ladder[0]).toEqual({ width: 2688, height: 1520 })
    expect(ladder[1]?.width).toBe(2560)
  })

  it('never offers a size above the source', () => {
    const ladder = resolutionLadder({ width: 1280, height: 720 })
    expect(ladder.map((o) => o.width)).toEqual([1280, 854, 640])
  })

  it('keeps the source aspect ratio and even dimensions for 4:3', () => {
    const ladder = resolutionLadder({ width: 1600, height: 1200 })
    expect(ladder[0]).toEqual({ width: 1600, height: 1200 })
    for (const option of ladder) {
      expect(option.width % 2).toBe(0)
      expect(option.height % 2).toBe(0)
      expect(Math.abs(option.width / option.height - 4 / 3)).toBeLessThan(0.01)
    }
  })

  it('falls back to the 16:9 standard widths when the source is unknown', () => {
    const ladder = resolutionLadder(undefined)
    expect(ladder[0]).toEqual({ width: 3840, height: 2160 })
    expect(ladder.at(-1)).toEqual({ width: 640, height: 360 })
  })
})

describe('migrateHeightToWidth', () => {
  const source = { width: 2560, height: 1440 }

  it('turns a stored height into a width at the source aspect and drops the height', () => {
    const stored: EncodeProfile = {
      video: { codec: 'h264', height: 720, bitrateKbps: 777, preset: 'fast' },
      audio: { codec: 'aac', bitrateKbps: 99 },
      outputArgs: ['-marker'],
    }
    const migrated = migrateHeightToWidth(stored, source)
    expect(migrated.video).toEqual({ codec: 'h264', width: 1280, bitrateKbps: 777, preset: 'fast' })
    expect(migrated.audio).toEqual({ codec: 'aac', bitrateKbps: 99 })
    expect(migrated.outputArgs).toEqual(['-marker'])
  })

  it('keeps the height when the source is unknown, so the stream keeps working', () => {
    const stored: EncodeProfile = { video: { codec: 'h264', height: 720 }, audio: 'passthrough' }
    expect(migrateHeightToWidth(stored, undefined)).toBe(stored)
  })

  it('leaves a profile that already has a width alone', () => {
    const stored: EncodeProfile = {
      video: { codec: 'h264', width: 640, height: 360 },
      audio: 'passthrough',
    }
    expect(migrateHeightToWidth(stored, source)).toBe(stored)
  })

  it('leaves a profile with no size alone', () => {
    const stored: EncodeProfile = { video: { codec: 'copy' }, audio: 'passthrough' }
    expect(migrateHeightToWidth(stored, source)).toBe(stored)
  })

  it('rounds the width to an even number', () => {
    const stored: EncodeProfile = { video: { codec: 'h264', height: 480 }, audio: 'passthrough' }
    expect(migrateHeightToWidth(stored, source).video.width).toBe(854)
  })
})
