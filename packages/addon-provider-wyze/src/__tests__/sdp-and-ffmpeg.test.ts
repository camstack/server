import { describe, expect, it } from 'vitest'
import { buildLazyRfc4571Url, buildSyntheticSdp } from '../constants.js'
import { buildKeyframeJpegArgs, ffmpegInputFormat } from '../snapshot-ffmpeg.js'

describe('buildSyntheticSdp', () => {
  it('builds an H264 SDP with packetization-mode', () => {
    const sdp = buildSyntheticSdp('h264')
    expect(sdp).toContain('m=video 0 RTP/AVP 96')
    expect(sdp).toContain('a=rtpmap:96 H264/90000')
    expect(sdp).toContain('a=fmtp:96 packetization-mode=1')
  })

  it('builds an H265 SDP without an H264 fmtp', () => {
    const sdp = buildSyntheticSdp('h265')
    expect(sdp).toContain('a=rtpmap:96 H265/90000')
    expect(sdp).not.toContain('packetization-mode')
  })
})

describe('buildLazyRfc4571Url', () => {
  it('encodes the camStreamId behind the lazy prefix', () => {
    const url = buildLazyRfc4571Url('native:main')
    expect(url.startsWith('lazy:rfc4571:')).toBe(true)
    expect(url).toBe(`lazy:rfc4571:${encodeURIComponent('native:main')}`)
  })
})

describe('ffmpeg snapshot args', () => {
  it('selects the demuxer per video type', () => {
    expect(ffmpegInputFormat('H264')).toBe('h264')
    expect(ffmpegInputFormat('H265')).toBe('hevc')
  })

  it('builds a single-frame image2 transcode arg vector', () => {
    const args = buildKeyframeJpegArgs('H264')
    expect(args).toContain('-frames:v')
    expect(args).toContain('1')
    expect(args).toContain('image2')
    expect(args).toContain('h264')
    expect(args[args.length - 1]).toBe('pipe:1')
  })

  it('uses the hevc demuxer for H265', () => {
    expect(buildKeyframeJpegArgs('H265')).toContain('hevc')
  })
})
