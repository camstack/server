/**
 * Per-camStream "source parser" selection: HOW the broker ingests an RTSP/RTMP
 * source. `native-*` = the built-in TS clients; `ffmpeg-*` = an ffmpeg re-mux
 * reader (also the vehicle for normalization). Pure — no I/O.
 */
export type SourceParserSetting =
  | 'native-tcp'
  | 'native-udp'
  | 'ffmpeg-tcp'
  | 'ffmpeg-udp' // rtsp
  | 'native'
  | 'ffmpeg' // rtmp (tcp-only)

const RTSP_OPTIONS: readonly SourceParserSetting[] = [
  'native-tcp',
  'native-udp',
  'ffmpeg-tcp',
  'ffmpeg-udp',
]
const RTMP_OPTIONS: readonly SourceParserSetting[] = ['native', 'ffmpeg']

/** The parser options offered for a source type; `[]` for non-URL-pull sources. */
export function sourceParserOptionsFor(sourceType: string): readonly SourceParserSetting[] {
  if (sourceType === 'rtsp') return RTSP_OPTIONS
  if (sourceType === 'rtmp') return RTMP_OPTIONS
  return []
}

export interface ResolvedSourceParser {
  readonly engine: 'native' | 'ffmpeg'
  readonly transport: 'tcp' | 'udp'
  /** True when native-udp was requested but fell back to native-tcp (reader
   *  not yet implemented). Callers log a one-time warning. */
  readonly fellBack: boolean
}

/**
 * Resolve a stored setting (or absence) into the effective reader shape. RTMP is
 * always tcp. `native-udp` is reserved — until its reader ships it resolves to
 * native-tcp with `fellBack: true`.
 */
export function resolveSourceParser(
  setting: SourceParserSetting | undefined,
  sourceType: string,
): ResolvedSourceParser {
  const isRtmp = sourceType === 'rtmp'
  switch (setting) {
    case 'ffmpeg-tcp':
      return { engine: 'ffmpeg', transport: 'tcp', fellBack: false }
    case 'ffmpeg-udp':
      return { engine: 'ffmpeg', transport: 'udp', fellBack: false }
    case 'ffmpeg':
      return { engine: 'ffmpeg', transport: 'tcp', fellBack: false }
    case 'native-udp':
      // Reserved: reader not shipped → fall back to native-tcp.
      return { engine: 'native', transport: 'tcp', fellBack: true }
    case 'native':
    case 'native-tcp':
    case undefined:
      return { engine: 'native', transport: isRtmp ? 'tcp' : 'tcp', fellBack: false }
    default:
      return { engine: 'native', transport: 'tcp', fellBack: false }
  }
}
