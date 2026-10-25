import { describe, it, expect } from 'vitest'
import { parseSdp, extractVideoTrack, extractAudioTrack, resolveTrackUrl } from '../rtsp/sdp-parser'

// ── Real-world SDP samples ──────────────────────────────────────────

/** Hikvision DS-2CD2xx5 — H.264 main stream + G.711 audio. */
const HIKVISION_H264_SDP = [
  'v=0',
  'o=- 1234567890 1 IN IP4 192.168.10.100',
  's=RTSP/RTP stream',
  't=0 0',
  'a=control:rtsp://192.168.10.100:554/Streaming/Channels/101',
  'm=video 0 RTP/AVP 96',
  'c=IN IP4 0.0.0.0',
  'b=AS:4096',
  'a=rtpmap:96 H264/90000',
  'a=fmtp:96 profile-level-id=420029;packetization-mode=1;sprop-parameter-sets=Z0IAKeKQFoAt2AQEBQAAAB9AAAOpgCA=,aM48gA==',
  'a=control:trackID=1',
  'm=audio 0 RTP/AVP 8',
  'c=IN IP4 0.0.0.0',
  'b=AS:64',
  'a=control:trackID=2',
].join('\r\n')

/** Reolink RLC-810A — H.265 main stream. */
const REOLINK_H265_SDP = [
  'v=0',
  'o=- 1 1 IN IP4 192.168.10.50',
  's=Session streamed by Reolink',
  't=0 0',
  'a=control:*',
  'm=video 0 RTP/AVP 96',
  'c=IN IP4 0.0.0.0',
  'a=rtpmap:96 H265/90000',
  'a=fmtp:96 sprop-vps=QAEMAf//AWAAAAMAAAMAAAMAAAMAlqwJ;sprop-sps=QgEBAWAAAAMAAAMAAAMAAAMAlqADwIAp5ZugarWEAAAAwAAAEAAAAZCoA==;sprop-pps=RAHBcrRiQA==',
  'a=control:trackID=1',
  'm=audio 0 RTP/AVP 97',
  'c=IN IP4 0.0.0.0',
  'a=rtpmap:97 MPEG4-GENERIC/16000/1',
  'a=fmtp:97 profile-level-id=15;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=1408',
  'a=control:trackID=2',
].join('\r\n')

/** Dahua — H.264 with absolute control URLs. */
const DAHUA_H264_SDP = [
  'v=0',
  'o=- 2024 1 IN IP4 192.168.10.108',
  's=Media Presentation',
  't=0 0',
  'a=control:rtsp://192.168.10.108:554/cam/realmonitor?channel=1&subtype=0',
  'm=video 0 RTP/AVP 96',
  'c=IN IP4 0.0.0.0',
  'a=rtpmap:96 H264/90000',
  'a=fmtp:96 profile-level-id=640028;packetization-mode=1;sprop-parameter-sets=Z2QAKKzZQHgCJ+WEAAADAAIAAAMDKDxYtlg=,aO+8sA==',
  'a=control:rtsp://192.168.10.108:554/cam/realmonitor?channel=1&subtype=0/trackID=0',
  'm=audio 0 RTP/AVP 0',
  'c=IN IP4 0.0.0.0',
  'a=control:rtsp://192.168.10.108:554/cam/realmonitor?channel=1&subtype=0/trackID=1',
].join('\r\n')

/** Amcrest IP2M-841 — H.264 substream (low res). */
const AMCREST_SUB_SDP = [
  'v=0',
  'o=- 1 1 IN IP4 10.0.0.20',
  's=RTSP Session',
  't=0 0',
  'm=video 0 RTP/AVP 96',
  'c=IN IP4 0.0.0.0',
  'a=rtpmap:96 H264/90000',
  'a=fmtp:96 packetization-mode=1;profile-level-id=42001e;sprop-parameter-sets=Z0IAHqtAUB7I,aM4xUg==',
  'a=control:track1',
].join('\r\n')

/** Minimal SDP with no fmtp (camera sends params in-band only). */
const MINIMAL_NO_FMTP_SDP = [
  'v=0',
  'o=- 0 0 IN IP4 0.0.0.0',
  's=stream',
  't=0 0',
  'm=video 0 RTP/AVP 96',
  'a=rtpmap:96 H264/90000',
  'a=control:streamid=0',
].join('\r\n')

/** SDP with only \n line endings (some cameras do this). */
const LF_ONLY_SDP = [
  'v=0',
  'o=- 0 0 IN IP4 0.0.0.0',
  's=test',
  't=0 0',
  'm=video 0 RTP/AVP 96',
  'a=rtpmap:96 H265/90000',
  'a=fmtp:96 sprop-vps=QAEMAf//AA==;sprop-sps=QgEBAA==;sprop-pps=RAHA',
  'a=control:track0',
].join('\n')

// ── Tests ───────────────────────────────────────────────────────────

describe('parseSdp', () => {
  it('parses session-level lines and media sections', () => {
    const parsed = parseSdp(HIKVISION_H264_SDP)
    expect(parsed.sessionLines.length).toBeGreaterThan(0)
    expect(parsed.mediaSections).toHaveLength(2)
    expect(parsed.mediaSections[0]!.type).toBe('video')
    expect(parsed.mediaSections[1]!.type).toBe('audio')
  })

  it('extracts session-level control', () => {
    const parsed = parseSdp(HIKVISION_H264_SDP)
    expect(parsed.sessionControl).toBe('rtsp://192.168.10.100:554/Streaming/Channels/101')
  })

  it('handles LF-only line endings', () => {
    const parsed = parseSdp(LF_ONLY_SDP)
    expect(parsed.mediaSections).toHaveLength(1)
    expect(parsed.mediaSections[0]!.codec).toBe('H265')
  })

  it('parses wildcard session control', () => {
    const parsed = parseSdp(REOLINK_H265_SDP)
    expect(parsed.sessionControl).toBe('*')
  })
})

describe('parseSdp — media section details', () => {
  it('extracts H.264 rtpmap + fmtp', () => {
    const parsed = parseSdp(HIKVISION_H264_SDP)
    const video = parsed.mediaSections[0]!
    expect(video.codec).toBe('H264')
    expect(video.clockRate).toBe(90000)
    expect(video.payloadTypes).toEqual([96])
    expect(video.fmtp['profile-level-id']).toBe('420029')
    expect(video.fmtp['packetization-mode']).toBe('1')
    expect(video.fmtp['sprop-parameter-sets']).toBeTruthy()
    expect(video.control).toBe('trackID=1')
  })

  it('extracts H.265 rtpmap + fmtp with separate vps/sps/pps', () => {
    const parsed = parseSdp(REOLINK_H265_SDP)
    const video = parsed.mediaSections[0]!
    expect(video.codec).toBe('H265')
    expect(video.clockRate).toBe(90000)
    expect(video.fmtp['sprop-vps']).toBeTruthy()
    expect(video.fmtp['sprop-sps']).toBeTruthy()
    expect(video.fmtp['sprop-pps']).toBeTruthy()
  })

  it('resolves PCMA from static payload type 8 (no rtpmap)', () => {
    const parsed = parseSdp(HIKVISION_H264_SDP)
    const audio = parsed.mediaSections[1]!
    expect(audio.type).toBe('audio')
    expect(audio.codec).toBe('PCMA')
    expect(audio.clockRate).toBe(8000)
  })

  it('resolves PCMU from static payload type 0 (Dahua)', () => {
    const parsed = parseSdp(DAHUA_H264_SDP)
    const audio = parsed.mediaSections[1]!
    expect(audio.codec).toBe('PCMU')
    expect(audio.clockRate).toBe(8000)
  })

  it('parses AAC audio fmtp (Reolink)', () => {
    const parsed = parseSdp(REOLINK_H265_SDP)
    const audio = parsed.mediaSections[1]!
    expect(audio.codec).toBe('MPEG4-GENERIC')
    expect(audio.clockRate).toBe(16000)
    expect(audio.channels).toBe(1)
    expect(audio.fmtp['mode']).toBe('AAC-hbr')
    expect(audio.fmtp['config']).toBe('1408')
  })

  it('handles absolute control URLs (Dahua)', () => {
    const parsed = parseSdp(DAHUA_H264_SDP)
    const video = parsed.mediaSections[0]!
    expect(video.control).toBe(
      'rtsp://192.168.10.108:554/cam/realmonitor?channel=1&subtype=0/trackID=0',
    )
  })
})

describe('extractVideoTrack', () => {
  it('extracts H.264 video track with CodecParams', () => {
    const parsed = parseSdp(HIKVISION_H264_SDP)
    const track = extractVideoTrack(parsed)
    expect(track).not.toBeNull()
    expect(track!.codec).toBe('h264')
    expect(track!.payloadType).toBe(96)
    expect(track!.clockRate).toBe(90000)
    expect(track!.profileLevelId).toBe('420029')
    expect(track!.codecParams).not.toBeNull()
    expect(track!.codecParams!.codec).toBe('h264')
    expect(track!.codecParams!.parameterSets).toHaveLength(2) // SPS + PPS
  })

  it('extracts H.265 video track with VPS/SPS/PPS', () => {
    const parsed = parseSdp(REOLINK_H265_SDP)
    const track = extractVideoTrack(parsed)
    expect(track).not.toBeNull()
    expect(track!.codec).toBe('h265')
    expect(track!.profileLevelId).toBeNull()
    expect(track!.codecParams).not.toBeNull()
    expect(track!.codecParams!.parameterSets).toHaveLength(3) // VPS + SPS + PPS
  })

  it('returns null codecParams when fmtp has no sprop', () => {
    const parsed = parseSdp(MINIMAL_NO_FMTP_SDP)
    const track = extractVideoTrack(parsed)
    expect(track).not.toBeNull()
    expect(track!.codec).toBe('h264')
    expect(track!.codecParams).toBeNull()
  })

  it('decodes base64 parameter sets into valid Buffers', () => {
    const parsed = parseSdp(HIKVISION_H264_SDP)
    const track = extractVideoTrack(parsed)!
    const sps = track.codecParams!.parameterSets[0]!
    const pps = track.codecParams!.parameterSets[1]!

    // SPS for H.264 starts with NAL type 7 (0x67 with forbidden+NRI bits)
    expect(sps[0]! & 0x1f).toBe(7)
    // PPS for H.264 starts with NAL type 8 (0x68 with forbidden+NRI bits)
    expect(pps[0]! & 0x1f).toBe(8)
  })
})

describe('extractAudioTrack', () => {
  it('extracts PCMA audio (Hikvision)', () => {
    const parsed = parseSdp(HIKVISION_H264_SDP)
    const audio = extractAudioTrack(parsed)
    expect(audio).not.toBeNull()
    expect(audio!.codec).toBe('PCMA')
    expect(audio!.clockRate).toBe(8000)
    expect(audio!.channels).toBe(1)
  })

  it('extracts AAC audio (Reolink)', () => {
    const parsed = parseSdp(REOLINK_H265_SDP)
    const audio = extractAudioTrack(parsed)
    expect(audio).not.toBeNull()
    expect(audio!.codec).toBe('MPEG4-GENERIC')
    expect(audio!.clockRate).toBe(16000)
  })

  it('returns null when no audio section', () => {
    const parsed = parseSdp(AMCREST_SUB_SDP)
    expect(extractAudioTrack(parsed)).toBeNull()
  })
})

describe('resolveTrackUrl', () => {
  const base = 'rtsp://192.168.10.100:554/Streaming/Channels/101'

  it('returns base when trackControl is null', () => {
    expect(resolveTrackUrl(base, null, null)).toBe(base)
  })

  it('returns absolute trackControl as-is', () => {
    const abs = 'rtsp://192.168.10.100:554/stream/trackID=1'
    expect(resolveTrackUrl(base, null, abs)).toBe(abs)
  })

  it('appends relative trackControl to base', () => {
    expect(resolveTrackUrl(base, null, 'trackID=1')).toBe(
      'rtsp://192.168.10.100:554/Streaming/Channels/101/trackID=1',
    )
  })

  it('uses session control as base when available', () => {
    const sessionCtrl = 'rtsp://192.168.10.100:554/session'
    expect(resolveTrackUrl(base, sessionCtrl, 'track1')).toBe(
      'rtsp://192.168.10.100:554/session/track1',
    )
  })

  it('handles base URL with trailing slash', () => {
    expect(resolveTrackUrl(base + '/', null, 'trackID=1')).toBe(
      'rtsp://192.168.10.100:554/Streaming/Channels/101/trackID=1',
    )
  })

  it('handles rtsps:// scheme', () => {
    const rtsps = 'rtsps://camera.example.com/stream'
    expect(resolveTrackUrl(rtsps, null, 'trackID=0')).toBe(
      'rtsps://camera.example.com/stream/trackID=0',
    )
  })
})
