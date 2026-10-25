import { describe, it, expect } from 'vitest'
import { extractAudioMediaBlock, appendAudioMediaBlock } from '../egress-audio-sdp.js'
import { buildSdp } from '../sdp-builder.js'

const AAC_SDP = [
  'v=0',
  'o=- 0 0 IN IP4 127.0.0.1',
  's=No Name',
  'c=IN IP4 127.0.0.1',
  't=0 0',
  'a=tool:libavformat 61.7.100',
  'm=audio 49170 RTP/AVP 96',
  'b=AS:128',
  'a=rtpmap:96 MPEG4-GENERIC/48000/2',
  'a=fmtp:96 profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=1190',
  '',
].join('\n')

const PCMU_SDP = [
  'v=0',
  'o=- 0 0 IN IP4 127.0.0.1',
  's=No Name',
  't=0 0',
  'm=audio 12340 RTP/AVP 0',
  'a=rtpmap:0 PCMU/8000',
  '',
].join('\n')

describe('extractAudioMediaBlock', () => {
  it('returns null when the SDP has no audio media section', () => {
    expect(extractAudioMediaBlock('v=0\r\nm=video 0 RTP/AVP 96\r\n')).toBeNull()
  })

  it('extracts AAC, forces port 0, remaps dynamic PT 96→97, adds trackID=1 + connection line', () => {
    const block = extractAudioMediaBlock(AAC_SDP)
    expect(block).not.toBeNull()
    const lines = block!.split('\r\n')
    expect(lines[0]).toBe('m=audio 0 RTP/AVP 97')
    expect(lines).toContain('c=IN IP4 0.0.0.0')
    expect(lines).toContain('a=rtpmap:97 MPEG4-GENERIC/48000/2')
    expect(lines.some((l) => l.startsWith('a=fmtp:97 ') && l.includes('config=1190'))).toBe(true)
    expect(lines[lines.length - 1]).toBe('a=control:trackID=1')
    // never collide with the video track payload type
    expect(block).not.toContain('RTP/AVP 96')
  })

  it('keeps a static payload type (PCMU=0) intact', () => {
    const block = extractAudioMediaBlock(PCMU_SDP)
    const lines = block!.split('\r\n')
    expect(lines[0]).toBe('m=audio 0 RTP/AVP 0')
    expect(lines).toContain('a=rtpmap:0 PCMU/8000')
    expect(lines).toContain('a=control:trackID=1')
  })

  it('honours a custom trackId', () => {
    const block = extractAudioMediaBlock(PCMU_SDP, { trackId: 3 })
    expect(block!.endsWith('a=control:trackID=3')).toBe(true)
  })

  it('drops any pre-existing a=control line from ffmpeg', () => {
    const withControl = AAC_SDP.replace('b=AS:128', 'b=AS:128\na=control:streamid=1')
    const block = extractAudioMediaBlock(withControl)
    expect(block!.match(/a=control:/g)?.length).toBe(1)
    expect(block).toContain('a=control:trackID=1')
  })
})

describe('appendAudioMediaBlock', () => {
  it('grafts the audio block onto a video-only SDP as a second track', () => {
    const videoSdp = buildSdp({
      codec: 'h264',
      parameterSets: [Buffer.from([0x67, 0x42, 0x00, 0x1e])],
      streamName: 'cam',
    })
    const audioBlock = extractAudioMediaBlock(PCMU_SDP)!
    const merged = appendAudioMediaBlock(videoSdp, audioBlock)

    // both tracks present, in order
    expect(merged.indexOf('m=video')).toBeLessThan(merged.indexOf('m=audio'))
    expect(merged).toContain('a=control:trackID=0')
    expect(merged).toContain('a=control:trackID=1')
    // CRLF framing + trailing blank preserved
    expect(merged.endsWith('\r\n')).toBe(true)
    expect(merged).not.toContain('\r\r')
  })
})
