/**
 * `computeDerivedEncode` is THE derived-encode computation: the broker's feeder
 * spawn and `previewDerivedEncode` both call it. This file pins it as a table
 * (profile x probed source -> effective encode). The start-path / preview parity
 * and the real probe read are in `derived-source-codec.spec.ts`.
 */
import type { DerivedSourceProbe, EncodeProfile } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { computeDerivedEncode } from '../derived/derived-transcode-args.js'

const SOURCE_1080P_H264: DerivedSourceProbe = {
  width: 1920,
  height: 1080,
  fps: 20,
  idrIntervalMs: 2000,
  videoCodec: 'h264',
  audioCodec: 'PCMU',
}

interface Row {
  readonly name: string
  readonly profile: EncodeProfile
  readonly source: DerivedSourceProbe
  readonly expected: Record<string, unknown>
}

const ROWS: readonly Row[] = [
  {
    name: 'resize + h264 + aac',
    profile: { video: { codec: 'h264', height: 360 }, audio: { codec: 'aac' } },
    source: SOURCE_1080P_H264,
    expected: {
      width: 640,
      height: 360,
      videoCodec: 'h264',
      encoder: 'libx264',
      fps: 20,
      fpsClampedToSource: false,
      capKbps: 500,
      targetKbps: 400,
      floorKbps: 200,
      raisedToFloor: false,
      gopFrames: 40,
      keyframeIntervalSec: 2,
      audio: 'profile',
    },
  },
  {
    name: 'resize only, source codec h265 kept',
    profile: { video: { codec: 'source', height: 720 }, audio: 'passthrough' },
    source: { ...SOURCE_1080P_H264, videoCodec: 'h265' },
    expected: {
      width: 1280,
      height: 720,
      videoCodec: 'h265',
      encoder: 'libx265',
      audio: 'aac',
    },
  },
  {
    name: 'fps above the source is clamped to it',
    profile: { video: { codec: 'h264', height: 360, fps: 60 }, audio: 'passthrough' },
    source: SOURCE_1080P_H264,
    expected: { fps: 20, requestedFps: 60, fpsClampedToSource: true },
  },
  {
    name: 'explicit bitrate below the floor is raised to it',
    profile: { video: { codec: 'h264', height: 720, bitrateKbps: 100 }, audio: 'passthrough' },
    source: SOURCE_1080P_H264,
    expected: {
      capKbps: 800,
      targetKbps: 640,
      floorKbps: 800,
      raisedToFloor: true,
      requestedKbps: 100,
    },
  },
  {
    name: 'audio none drops the track',
    profile: { video: { codec: 'h264', height: 360 }, audio: { codec: 'none' } },
    source: SOURCE_1080P_H264,
    expected: { audio: 'none' },
  },
  {
    name: 'unmeasured source fps stays null, never 0',
    profile: { video: { codec: 'h264', height: 360 }, audio: 'passthrough' },
    source: { ...SOURCE_1080P_H264, fps: null, idrIntervalMs: null },
    expected: { fps: null, keyframeIntervalSec: null, fpsClampedToSource: false },
  },
  {
    name: 'copy remuxes: source picture, no resize',
    profile: { video: { codec: 'copy' }, audio: 'passthrough' },
    source: SOURCE_1080P_H264,
    expected: { videoCodec: 'copy', width: 1920, height: 1080, encoder: 'copy' },
  },
]

describe('computeDerivedEncode', () => {
  it.each(ROWS)('$name', ({ profile, source, expected }) => {
    const { preview } = computeDerivedEncode(profile, source)
    expect(preview).toMatchObject(expected)
  })

  it('resize + h264 + aac scales the argv and encodes aac', () => {
    const { preview } = computeDerivedEncode(ROWS[0]!.profile, SOURCE_1080P_H264)
    expect(preview.args.join(' ')).toContain('scale=')
    expect(preview.args).toContain('libx264')
    expect(preview.args).toContain('aac')
  })

  it('a width alone scales by that width, the height following the source aspect', () => {
    const profile: EncodeProfile = { video: { codec: 'h264', width: 854 }, audio: 'passthrough' }
    const { preview } = computeDerivedEncode(profile, SOURCE_1080P_H264)
    expect(preview).toMatchObject({ width: 854, height: 480 })
    expect(preview.args.join(' ')).toContain('scale=')
    expect(preview.args.join(' ')).toContain('854')
    expect(preview.args.join(' ')).toContain('480')
  })

  it('a stored height still gives the same picture as the matching width', () => {
    const byHeight: EncodeProfile = { video: { codec: 'h264', height: 480 }, audio: 'passthrough' }
    const byWidth: EncodeProfile = { video: { codec: 'h264', width: 854 }, audio: 'passthrough' }
    const a = computeDerivedEncode(byHeight, SOURCE_1080P_H264).preview
    const b = computeDerivedEncode(byWidth, SOURCE_1080P_H264).preview
    expect(a.args).toEqual(b.args)
  })

  it('audio none emits -an', () => {
    const { preview } = computeDerivedEncode(ROWS[4]!.profile, SOURCE_1080P_H264)
    expect(preview.args).toContain('-an')
  })
})
