import { describe, it, expect } from 'vitest'
import type { EncodeProfile } from '@camstack/types'
import { resolveEncodeProfile, withSourceResolution } from '../encode-profile-resolver.js'

const consumerDefault: EncodeProfile = {
  video: {
    codec: 'h264',
    profile: 'baseline',
    width: 1280,
    height: 720,
    fps: 25,
    bitrateKbps: 3000,
    gopFrames: 30,
    bf: 0,
    preset: 'ultrafast',
    tune: 'zerolatency',
  },
  audio: 'passthrough',
}

const mobilePreset: EncodeProfile = {
  video: {
    codec: 'h264',
    profile: 'baseline',
    width: 854,
    height: 480,
    fps: 15,
    bitrateKbps: 600,
    gopFrames: 15,
    bf: 0,
    preset: 'ultrafast',
    tune: 'zerolatency',
  },
  audio: 'passthrough',
}

describe('resolveEncodeProfile', () => {
  it('returns the consumer default by reference when no override is set', () => {
    const got = resolveEncodeProfile(undefined, consumerDefault)
    expect(got).toBe(consumerDefault)
  })

  it('returns the override directly when an override is set', () => {
    const got = resolveEncodeProfile(mobilePreset, consumerDefault)
    expect(got).toBe(mobilePreset)
  })

  it('does not mutate the override on read', () => {
    const snapshot = structuredClone(mobilePreset)
    resolveEncodeProfile(mobilePreset, consumerDefault)
    expect(mobilePreset).toEqual(snapshot)
  })
})

describe('withSourceResolution', () => {
  // The forced-transcode path (H.265 source → H.264-only browser, or a
  // "Custom" preset that picks a different codec) used to scale every
  // re-encoded session to the baked default's 1280×720. A 4K source
  // was needlessly downscaled. withSourceResolution overrides the
  // baked default's video.{width,height} with the source's probed
  // dimensions, so a 4K cam stays 4K H.264 on the wire when no
  // operator override is present.

  it('returns the consumer default by reference when probed source is undefined', () => {
    const got = withSourceResolution(consumerDefault, undefined)
    expect(got).toBe(consumerDefault)
  })

  it('returns the consumer default by reference when probed source carries no width/height', () => {
    const probed: EncodeProfile = {
      video: { codec: 'h265' },
      audio: 'passthrough',
    }
    const got = withSourceResolution(consumerDefault, probed)
    expect(got).toBe(consumerDefault)
  })

  it('returns the consumer default by reference when only width is probed', () => {
    const probed: EncodeProfile = {
      video: { codec: 'h265', width: 3840 },
      audio: 'passthrough',
    }
    const got = withSourceResolution(consumerDefault, probed)
    expect(got).toBe(consumerDefault)
  })

  it('returns the consumer default by reference when only height is probed', () => {
    const probed: EncodeProfile = {
      video: { codec: 'h265', height: 2160 },
      audio: 'passthrough',
    }
    const got = withSourceResolution(consumerDefault, probed)
    expect(got).toBe(consumerDefault)
  })

  it('injects probed width and height into the video shape when both are set', () => {
    const probed: EncodeProfile = {
      video: { codec: 'h265', width: 3840, height: 2160 },
      audio: 'passthrough',
    }
    const got = withSourceResolution(consumerDefault, probed)
    expect(got).not.toBe(consumerDefault)
    expect(got.video.width).toBe(3840)
    expect(got.video.height).toBe(2160)
  })

  it('keeps codec, profile, fps, bitrate, gop, preset and tune from the consumer default', () => {
    const probed: EncodeProfile = {
      video: { codec: 'h265', width: 3840, height: 2160 },
      audio: 'passthrough',
    }
    const got = withSourceResolution(consumerDefault, probed)
    expect(got.video.codec).toBe('h264')
    expect(got.video.profile).toBe('baseline')
    expect(got.video.fps).toBe(25)
    expect(got.video.bitrateKbps).toBe(3000)
    expect(got.video.gopFrames).toBe(30)
    expect(got.video.preset).toBe('ultrafast')
    expect(got.video.tune).toBe('zerolatency')
  })

  it('keeps audio from the consumer default', () => {
    const audioDefault: EncodeProfile = {
      ...consumerDefault,
      audio: { codec: 'opus', bitrateKbps: 64, sampleRateHz: 48000, channels: 1 },
    }
    const probed: EncodeProfile = {
      video: { codec: 'h265', width: 1920, height: 1080 },
      audio: 'passthrough',
    }
    const got = withSourceResolution(audioDefault, probed)
    expect(got.audio).toEqual({ codec: 'opus', bitrateKbps: 64, sampleRateHz: 48000, channels: 1 })
  })

  it('does not mutate the consumer default on read', () => {
    const probed: EncodeProfile = {
      video: { codec: 'h265', width: 3840, height: 2160 },
      audio: 'passthrough',
    }
    const snapshot = structuredClone(consumerDefault)
    withSourceResolution(consumerDefault, probed)
    expect(consumerDefault).toEqual(snapshot)
  })
})
