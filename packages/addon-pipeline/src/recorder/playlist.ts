export interface VariantSegment {
  uri: string
  startMs: number
  durMs: number
}

/** A VOD variant playlist with an absolute wall-clock anchor per segment. */
export function buildVariantPlaylist(segments: readonly VariantSegment[]): string {
  const maxDur = segments.reduce((m, s) => Math.max(m, s.durMs), 0)
  const lines: string[] = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-TARGETDURATION:${Math.ceil(maxDur / 1000)}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
  ]
  segments.forEach((s, i) => {
    // Each segment is muxed with `-reset_timestamps 1` (ffmpeg-args.ts), so its
    // PTS restarts at ~0. Concatenated without a marker, hls.js expects monotonic
    // timestamps and stalls at the first segment's end instead of advancing. A
    // discontinuity before every boundary (not the first segment) tells the player
    // each segment begins a fresh timeline, so VOD plays straight through.
    if (i > 0) lines.push('#EXT-X-DISCONTINUITY')
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(s.startMs).toISOString()}`)
    lines.push(`#EXTINF:${(s.durMs / 1000).toFixed(3)},`)
    lines.push(s.uri)
  })
  lines.push('#EXT-X-ENDLIST')
  return lines.join('\n') + '\n'
}

export interface MasterVariant {
  profile: string
  bandwidth: number
  uri: string
  /** RFC 6381 codec string (`avc1.640033` / `hev1.1.6.L120.B0`). When present,
   *  hls.js calls `MediaSource.isTypeSupported` on it and DROPS variants the
   *  browser can't decode — so Chrome skips HEVC and picks an H.264 variant. */
  codecs?: string
  /** Video resolution `WxH` for the ABR ladder. */
  resolution?: { width: number; height: number }
}

/** A master (multi-variant) playlist enabling client ABR / profile selection. */
export function buildMasterPlaylist(variants: readonly MasterVariant[]): string {
  const lines: string[] = ['#EXTM3U', '#EXT-X-VERSION:7']
  for (const v of variants) {
    const attrs = [`BANDWIDTH=${v.bandwidth}`]
    if (v.resolution) attrs.push(`RESOLUTION=${v.resolution.width}x${v.resolution.height}`)
    if (v.codecs) attrs.push(`CODECS="${v.codecs}"`)
    attrs.push(`NAME="${v.profile}"`)
    lines.push(`#EXT-X-STREAM-INF:${attrs.join(',')}`)
    lines.push(v.uri)
  }
  return lines.join('\n') + '\n'
}
