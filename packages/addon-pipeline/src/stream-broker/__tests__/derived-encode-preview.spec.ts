/**
 * `computeDerivedEncode` is THE derived-encode computation: the broker's feeder
 * spawn and `previewDerivedEncode` both call it. This file pins it as a table
 * (profile x probed source -> effective encode) and proves the two callers
 * return the same argv for the same input.
 */
import type { DerivedSourceProbe, EncodeProfile } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computeDerivedEncode } from '../derived/derived-transcode-args.js'

const captured: { args: readonly string[] | null } = { args: null }

vi.mock('../derived/derived-stream-feeder.js', () => ({
  DerivedStreamFeeder: class {
    constructor(options: { args: readonly string[] }) {
      captured.args = options.args
    }
    connect(): void {}
  },
}))
vi.mock('../stream-broker/ffmpeg-invocation.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireBrokerFfmpeg: () => '/usr/bin/ffmpeg',
}))

const { StreamBrokerManager } = await import('../stream-broker/stream-broker-manager.js')

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

  it('audio none emits -an', () => {
    const { preview } = computeDerivedEncode(ROWS[4]!.profile, SOURCE_1080P_H264)
    expect(preview.args).toContain('-an')
  })
})

describe('the broker start path and the preview share one computation', () => {
  beforeEach(() => {
    captured.args = null
  })

  it('returns identical args for the same profile and source', async () => {
    const manager = new StreamBrokerManager({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child() {
        return this
      },
      withTags() {
        return this
      },
    })
    const profile: EncodeProfile = {
      video: { codec: 'h264', height: 360, fps: 60, bitrateKbps: 50 },
      audio: { codec: 'aac' },
    }
    const internals = manager as unknown as {
      observedSourceProbe: () => DerivedSourceProbe
      rtspProvider: { getInternalEntry: () => { url: string } }
      spawnDerivedFeeder: (...a: unknown[]) => Promise<unknown>
    }
    internals.observedSourceProbe = () => SOURCE_1080P_H264
    internals.rtspProvider = { getInternalEntry: () => ({ url: 'rtsp://loop/back' }) }

    await internals.spawnDerivedFeeder(
      7,
      'derived:x',
      { kind: 'camStream', camStreamId: 'native:main' },
      profile,
      {},
      () => {},
    )
    const preview = await manager.previewDerivedEncode({
      deviceId: 7,
      profile,
      source: { kind: 'camStream', camStreamId: 'native:main' },
    })

    expect(preview.kind).toBe('preview')
    if (preview.kind !== 'preview') return
    const started = captured.args
    expect(started).not.toBeNull()
    // Only the `-i` source differs: the preview has no loopback to dial.
    const swapUrl = (args: readonly string[], url: string): string[] =>
      args.map((a) => (a === url ? '<src>' : a))
    expect(swapUrl(preview.preview.args, 'rtsp://source.invalid/preview')).toEqual(
      swapUrl(started ?? [], 'rtsp://loop/back'),
    )
    expect(preview.preview.fpsClampedToSource).toBe(true)
    expect(preview.preview.raisedToFloor).toBe(true)
  })

  it('answers no-source before anything is probed', async () => {
    const manager = new StreamBrokerManager({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child() {
        return this
      },
      withTags() {
        return this
      },
    })
    const result = await manager.previewDerivedEncode({
      deviceId: 404,
      profile: { video: { codec: 'h264', height: 360 }, audio: 'passthrough' },
    })
    expect(result).toEqual({ kind: 'no-source' })
  })
})
