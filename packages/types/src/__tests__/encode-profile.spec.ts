import { describe, it, expect } from 'vitest'
import { EncodeProfileSchema, encodeProfileFromStreamShape } from '../encode-profile.js'

describe('EncodeProfile schemas', () => {
  it('parses a video-only h264 profile with audio passthrough', () => {
    const profile = {
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
    expect(EncodeProfileSchema.parse(profile)).toEqual(profile)
  })

  it('parses a video + opus audio profile', () => {
    const profile = {
      video: { codec: 'copy' },
      audio: { codec: 'opus', bitrateKbps: 64, sampleRateHz: 48000, channels: 2 },
    }
    expect(EncodeProfileSchema.parse(profile)).toEqual(profile)
  })

  it('accepts top-level inputArgs and outputArgs arrays', () => {
    const profile = {
      video: { codec: 'h264' },
      audio: 'passthrough' as const,
      inputArgs: ['-thread_queue_size', '1024', '-re'],
      outputArgs: ['-bsf:v', 'h264_mp4toannexb', '-flush_packets', '1'],
    }
    expect(EncodeProfileSchema.parse(profile)).toEqual(profile)
  })

  it('rejects an EncodeProfile with negative width', () => {
    const bad = { video: { codec: 'h264', width: -10 }, audio: 'passthrough' }
    expect(() => EncodeProfileSchema.parse(bad)).toThrow()
  })

  it('rejects audio.codec outside the allowed set', () => {
    const bad = { video: { codec: 'h264' }, audio: { codec: 'mp3' } }
    expect(() => EncodeProfileSchema.parse(bad)).toThrow()
  })
})

describe('encodeProfileFromStreamShape', () => {
  it('returns undefined when no width/height/fps is advertised', () => {
    expect(encodeProfileFromStreamShape({})).toBeUndefined()
    expect(encodeProfileFromStreamShape({ codec: 'h264' })).toBeUndefined()
  })

  it('builds a video shape with resolution + audio passthrough when width/height known', () => {
    const profile = encodeProfileFromStreamShape({
      codec: 'h264',
      resolution: { width: 1920, height: 1080 },
    })
    expect(profile).toEqual({
      video: { codec: 'h264', width: 1920, height: 1080 },
      audio: 'passthrough',
    })
  })

  it('canonicalizes HEVC/h.265 string variants to "h265"', () => {
    expect(encodeProfileFromStreamShape({ codec: 'H.265', fps: 25 })?.video.codec).toBe('h265')
    expect(encodeProfileFromStreamShape({ codec: 'HEVC', fps: 25 })?.video.codec).toBe('h265')
    expect(encodeProfileFromStreamShape({ codec: 'hevc', fps: 25 })?.video.codec).toBe('h265')
  })

  it('defaults to h264 for unknown / absent codec when other fields differentiate the stream', () => {
    expect(encodeProfileFromStreamShape({ fps: 30 })?.video.codec).toBe('h264')
    expect(encodeProfileFromStreamShape({ codec: 'mjpeg', fps: 15 })?.video.codec).toBe('h264')
  })

  it('returns distinct shapes for streams with different resolutions', () => {
    const main = encodeProfileFromStreamShape({
      codec: 'h264',
      resolution: { width: 1920, height: 1080 },
    })
    const sub = encodeProfileFromStreamShape({
      codec: 'h264',
      resolution: { width: 640, height: 360 },
    })
    expect(main?.video.width).toBe(1920)
    expect(sub?.video.width).toBe(640)
    expect(main).not.toEqual(sub)
  })
})
