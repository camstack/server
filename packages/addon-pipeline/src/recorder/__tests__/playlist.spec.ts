import { describe, it, expect } from 'vitest'
import { buildVariantPlaylist, buildMasterPlaylist } from '../playlist.js'

describe('playlist', () => {
  it('builds a VOD variant playlist with PROGRAM-DATE-TIME per segment', () => {
    const m3u8 = buildVariantPlaylist([
      { uri: '1780000496000-4000.m4s', startMs: 1780000496000, durMs: 4000 },
      { uri: '1780000500000-4000.m4s', startMs: 1780000500000, durMs: 4000 },
    ])
    expect(m3u8).toContain('#EXTM3U')
    expect(m3u8).toContain('#EXT-X-PLAYLIST-TYPE:VOD')
    expect(m3u8).toContain('#EXTINF:4.000,')
    expect(m3u8).toContain('#EXT-X-PROGRAM-DATE-TIME:' + new Date(1780000496000).toISOString())
    expect(m3u8.trim().endsWith('#EXT-X-ENDLIST')).toBe(true)
  })

  it('marks every boundary with EXT-X-DISCONTINUITY (segments use -reset_timestamps)', () => {
    // ffmpeg writes each .m4s with PTS reset to ~0 (ffmpeg-args.ts -reset_timestamps 1).
    // Without a discontinuity tag, hls.js expects monotonic timestamps and STALLS
    // at the first segment's end instead of advancing — so each inter-segment
    // boundary must carry #EXT-X-DISCONTINUITY.
    const m3u8 = buildVariantPlaylist([
      { uri: 'a.m4s', startMs: 1780000496000, durMs: 4000 },
      { uri: 'b.m4s', startMs: 1780000500000, durMs: 4000 },
      { uri: 'c.m4s', startMs: 1780000504000, durMs: 4000 },
    ])
    // One discontinuity per inter-segment boundary (segments - 1).
    const count = m3u8.split('\n').filter((l) => l === '#EXT-X-DISCONTINUITY').length
    expect(count).toBe(2)
    // The marker precedes the segment it resets to (before its PROGRAM-DATE-TIME).
    expect(m3u8).toContain(
      '#EXT-X-DISCONTINUITY\n#EXT-X-PROGRAM-DATE-TIME:' + new Date(1780000500000).toISOString(),
    )
  })

  it('does not emit a leading discontinuity before the first segment', () => {
    const m3u8 = buildVariantPlaylist([{ uri: 'a.m4s', startMs: 1780000496000, durMs: 4000 }])
    expect(m3u8.split('\n').filter((l) => l === '#EXT-X-DISCONTINUITY')).toHaveLength(0)
  })
  it('builds a master playlist referencing each profile variant with BANDWIDTH', () => {
    const m = buildMasterPlaylist([
      { profile: 'main', bandwidth: 4_000_000, uri: 'main.m3u8' },
      { profile: 'sub', bandwidth: 500_000, uri: 'sub.m3u8' },
    ])
    expect(m).toContain('#EXT-X-STREAM-INF:BANDWIDTH=4000000')
    expect(m).toContain('main.m3u8')
    expect(m).toContain('sub.m3u8')
  })

  it('emits CODECS + RESOLUTION so a player can filter undecodable variants', () => {
    const m = buildMasterPlaylist([
      {
        profile: 'high',
        bandwidth: 4_000_000,
        uri: 'high.m3u8',
        codecs: 'hev1.1.6.L120.B0',
        resolution: { width: 3840, height: 2160 },
      },
      {
        profile: 'mid',
        bandwidth: 1_500_000,
        uri: 'mid.m3u8',
        codecs: 'avc1.640033',
        resolution: { width: 896, height: 512 },
      },
    ])
    expect(m).toContain(
      '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=3840x2160,CODECS="hev1.1.6.L120.B0",NAME="high"',
    )
    expect(m).toContain(
      '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=896x512,CODECS="avc1.640033",NAME="mid"',
    )
  })
})
