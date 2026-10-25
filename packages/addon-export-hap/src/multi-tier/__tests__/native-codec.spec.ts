/**
 * Which codec the multi-tier service advertises.
 *
 * The whole reason this service exists is that the kitchen camera is native
 * HEVC and the classic HomeKit service carries H.264 only, so we transcode 4K
 * HEVC down to H.264 just to show it. Getting this value wrong in either
 * direction is expensive and silent:
 *
 *  - claiming H.265 on an H.264 camera offers a controller a stream we cannot
 *    produce without the transcode we are trying to avoid
 *  - claiming H.264 on the HEVC camera keeps the transcode forever, which is
 *    the defect
 *
 * So it is DERIVED from the streams the camera really publishes, and a camera
 * that publishes nothing readable falls back to H.264 — the codec every
 * controller accepts, and the one the classic path already serves.
 */
import { describe, expect, it } from 'vitest'

import { nativeCodecForStreams, sensorForStreams } from '../native-codec.js'
import { TierVideoCodec } from '../video-stream-tiers.js'

describe('nativeCodecForStreams', () => {
  it('reads HEVC off the largest stream', () => {
    expect(
      nativeCodecForStreams([
        { codec: 'h264', resolution: { width: 640, height: 360 } },
        { codec: 'h265', resolution: { width: 2560, height: 1920 } },
      ]),
    ).toBe(TierVideoCodec.H265)
  })

  it('does not let a small HEVC substream speak for a H.264 camera', () => {
    expect(
      nativeCodecForStreams([
        { codec: 'h264', resolution: { width: 1920, height: 1080 } },
        { codec: 'h265', resolution: { width: 640, height: 360 } },
      ]),
    ).toBe(TierVideoCodec.H264)
  })

  it('accepts the spellings a publisher really uses', () => {
    for (const spelling of ['h265', 'H265', 'hevc', 'HEVC', 'h.265']) {
      expect(
        nativeCodecForStreams([{ codec: spelling, resolution: { width: 1920, height: 1080 } }]),
      ).toBe(TierVideoCodec.H265)
    }
  })

  it('falls back to H.264 when nothing says otherwise', () => {
    expect(nativeCodecForStreams([])).toBe(TierVideoCodec.H264)
    expect(nativeCodecForStreams([{ resolution: { width: 1920, height: 1080 } }])).toBe(
      TierVideoCodec.H264,
    )
  })

  it('still answers when a stream has no resolution to rank it by', () => {
    expect(nativeCodecForStreams([{ codec: 'h265' }])).toBe(TierVideoCodec.H265)
  })
})

describe('sensorForStreams', () => {
  /**
   * The codec and the sensor size must describe the SAME stream.
   *
   * They did not, and the kitchen camera is the proof: the codec came from the
   * published streams (h265, correct) while the size came from the CLASSIC
   * service's advertised resolution list, which is capped at 1080p because that
   * is what the classic service accepts. So the accessory told a controller
   * "H.265, 1920x1080" about a camera whose main stream is 3840x2160 H.265 —
   * and the new service exists precisely to carry that 4K.
   */
  it('reports the largest stream, not a capped advertised list', () => {
    const sensor = sensorForStreams([
      { codec: 'h265', resolution: { width: 3840, height: 2160 } },
      { codec: 'h265', resolution: { width: 640, height: 360 } },
      { codec: 'h265', resolution: { width: 1280, height: 720 } },
    ])
    expect(sensor.width).toBe(3840)
    expect(sensor.height).toBe(2160)
    expect(sensor.codec).toBe(TierVideoCodec.H265)
  })

  it('takes the codec from the stream it took the size from', () => {
    const sensor = sensorForStreams([
      { codec: 'h264', resolution: { width: 2560, height: 1440 } },
      { codec: 'h265', resolution: { width: 640, height: 360 } },
    ])
    expect(sensor.width).toBe(2560)
    expect(sensor.codec).toBe(TierVideoCodec.H264)
  })

  it('falls back to 1080p H.264 when the camera publishes nothing readable', () => {
    const sensor = sensorForStreams([])
    expect(sensor).toEqual({ width: 1920, height: 1080, codec: TierVideoCodec.H264 })
  })
})
