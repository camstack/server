import { describe, expect, it } from 'vitest'
import { resolveSourceParser, sourceParserOptionsFor } from '../source-parser.js'

describe('sourceParserOptionsFor', () => {
  it('offers 4 options for rtsp (native-udp reserved)', () => {
    expect(sourceParserOptionsFor('rtsp')).toEqual([
      'native-tcp',
      'native-udp',
      'ffmpeg-tcp',
      'ffmpeg-udp',
    ])
  })
  it('offers native/ffmpeg for rtmp (tcp-only, no udp)', () => {
    expect(sourceParserOptionsFor('rtmp')).toEqual(['native', 'ffmpeg'])
  })
  it('offers nothing for non-URL-pull sources', () => {
    for (const t of ['rfc4571', 'push', 'push-rtp', 'placeholder']) {
      expect(sourceParserOptionsFor(t)).toEqual([])
    }
  })
})

describe('resolveSourceParser', () => {
  it('defaults to native-tcp for rtsp when unset', () => {
    expect(resolveSourceParser(undefined, 'rtsp')).toEqual({
      engine: 'native',
      transport: 'tcp',
      fellBack: false,
    })
  })
  it('maps ffmpeg-udp to ffmpeg + udp', () => {
    expect(resolveSourceParser('ffmpeg-udp', 'rtsp')).toEqual({
      engine: 'ffmpeg',
      transport: 'udp',
      fellBack: false,
    })
  })
  it('falls native-udp back to native-tcp with fellBack=true (reader not shipped)', () => {
    expect(resolveSourceParser('native-udp', 'rtsp')).toEqual({
      engine: 'native',
      transport: 'tcp',
      fellBack: true,
    })
  })
  it('maps rtmp native/ffmpeg to tcp transport', () => {
    expect(resolveSourceParser('ffmpeg', 'rtmp')).toEqual({
      engine: 'ffmpeg',
      transport: 'tcp',
      fellBack: false,
    })
    expect(resolveSourceParser(undefined, 'rtmp')).toEqual({
      engine: 'native',
      transport: 'tcp',
      fellBack: false,
    })
  })
})
