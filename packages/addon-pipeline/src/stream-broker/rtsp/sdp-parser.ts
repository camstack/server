import type { CodecParams } from './rtsp-types.js'

/** Parsed representation of an SDP media section (m= block). */
export interface SdpMediaSection {
  /** Media type: "video", "audio", "application". */
  readonly type: string
  /** RTP port (0 for TCP interleaved). */
  readonly port: number
  /** Transport protocol (e.g. "RTP/AVP"). */
  readonly protocol: string
  /** Payload types listed on the m= line. */
  readonly payloadTypes: ReadonlyArray<number>
  /** Codec name from a=rtpmap (e.g. "H264", "H265", "PCMU"). */
  readonly codec: string | null
  /** Clock rate from a=rtpmap (e.g. 90000 for video). */
  readonly clockRate: number | null
  /** Audio channel count from a=rtpmap (null for video). */
  readonly channels: number | null
  /** Parsed a=fmtp parameters as key-value pairs. */
  readonly fmtp: Readonly<Record<string, string>>
  /** Track control URL from a=control (may be relative or absolute). */
  readonly control: string | null
  /** Raw SDP lines for this section. */
  readonly lines: ReadonlyArray<string>
}

/** Result of parsing a full SDP response. */
export interface ParsedSdp {
  /** Session-level lines (before the first m= line). */
  readonly sessionLines: ReadonlyArray<string>
  /** Session-level a=control (base URL for relative track controls). */
  readonly sessionControl: string | null
  /** All parsed media sections. */
  readonly mediaSections: ReadonlyArray<SdpMediaSection>
}

/** Parsed video track info ready for native RTSP client use. */
export interface SdpVideoTrack {
  /** Index of this media section in the SDP. */
  readonly sectionIndex: number
  /** Codec: "h264" or "h265". */
  readonly codec: 'h264' | 'h265'
  /** RTP payload type (usually 96+). */
  readonly payloadType: number
  /** Clock rate (90000 for video). */
  readonly clockRate: number
  /** Track control URL from a=control. */
  readonly control: string | null
  /** H.264 profile-level-id (hex string, e.g. "42001e"). Null for H.265. */
  readonly profileLevelId: string | null
  /** Codec parameters extracted from SDP fmtp (SPS/PPS for H264, VPS/SPS/PPS for H265). */
  readonly codecParams: CodecParams | null
}

/** Parsed audio track info. */
export interface SdpAudioTrack {
  /** Index of this media section in the SDP. */
  readonly sectionIndex: number
  /** Codec name (e.g. "PCMU", "PCMA", "MPEG4-GENERIC", "opus"). */
  readonly codec: string
  /** RTP payload type. */
  readonly payloadType: number
  /** Clock rate (e.g. 8000, 48000). */
  readonly clockRate: number
  /** Channel count. */
  readonly channels: number
  /** Track control URL from a=control. */
  readonly control: string | null
  /** Raw fmtp parameters. */
  readonly fmtp: Readonly<Record<string, string>>
}

/**
 * Parse a raw SDP text into structured sections.
 *
 * Handles:
 * - Session-level and media-level attributes
 * - Multiple media sections (video, audio, application)
 * - a=rtpmap, a=fmtp, a=control extraction
 * - Tolerant of \r\n and \n line endings
 */
export function parseSdp(sdpText: string): ParsedSdp {
  const lines = sdpText.split(/\r?\n/).filter((l) => l.length > 0)

  const sessionLines: string[] = []
  const sections: Array<{ mLine: string; lines: string[] }> = []
  let currentSection: { mLine: string; lines: string[] } | null = null

  for (const line of lines) {
    if (line.startsWith('m=')) {
      currentSection = { mLine: line, lines: [line] }
      sections.push(currentSection)
    } else if (currentSection) {
      currentSection.lines.push(line)
    } else {
      sessionLines.push(line)
    }
  }

  const sessionControl = extractAttribute(sessionLines, 'control')

  const mediaSections = sections.map((s) => parseMediaSection(s.mLine, s.lines))

  return { sessionLines, sessionControl, mediaSections }
}

/**
 * Extract the first video track from a parsed SDP.
 * Returns null if no supported video codec found.
 */
export function extractVideoTrack(parsed: ParsedSdp): SdpVideoTrack | null {
  for (let i = 0; i < parsed.mediaSections.length; i++) {
    const section = parsed.mediaSections[i]!
    if (section.type !== 'video') continue

    const codecUpper = section.codec?.toUpperCase() ?? null
    if (codecUpper !== 'H264' && codecUpper !== 'H265') continue

    const codec: 'h264' | 'h265' = codecUpper === 'H264' ? 'h264' : 'h265'
    const payloadType = section.payloadTypes[0] ?? 96
    const clockRate = section.clockRate ?? 90000

    const codecParams = extractCodecParams(codec, section.fmtp)
    const profileLevelId = codec === 'h264' ? (section.fmtp['profile-level-id'] ?? null) : null

    return {
      sectionIndex: i,
      codec,
      payloadType,
      clockRate,
      control: section.control,
      profileLevelId,
      codecParams,
    }
  }
  return null
}

/**
 * Extract the first audio track from a parsed SDP.
 * Returns null if no audio section found.
 */
export function extractAudioTrack(parsed: ParsedSdp): SdpAudioTrack | null {
  for (let i = 0; i < parsed.mediaSections.length; i++) {
    const section = parsed.mediaSections[i]!
    if (section.type !== 'audio') continue

    return {
      sectionIndex: i,
      codec: section.codec ?? 'unknown',
      payloadType: section.payloadTypes[0] ?? 0,
      clockRate: section.clockRate ?? 8000,
      channels: section.channels ?? 1,
      control: section.control,
      fmtp: section.fmtp,
    }
  }
  return null
}

/**
 * Resolve a track control URL against the session-level control / RTSP base URL.
 *
 * Cameras vary wildly:
 * - Absolute: "rtsp://192.168.10.100/trackID=1"
 * - Relative: "trackID=1" or "track1"
 * - Session control: "rtsp://192.168.10.100/stream1" with track "trackID=1"
 */
export function resolveTrackUrl(
  baseUrl: string,
  sessionControl: string | null,
  trackControl: string | null,
): string {
  if (!trackControl) return baseUrl

  // Absolute URL — use as-is
  if (trackControl.startsWith('rtsp://') || trackControl.startsWith('rtsps://')) {
    return trackControl
  }

  // Use session control as base if it's an absolute URL
  const base =
    sessionControl &&
    (sessionControl.startsWith('rtsp://') || sessionControl.startsWith('rtsps://'))
      ? sessionControl
      : baseUrl

  // Append track control to base
  const separator = base.endsWith('/') ? '' : '/'
  return `${base}${separator}${trackControl}`
}

// ── Internal helpers ────────────────────────────────────────────────

function parseMediaSection(mLine: string, lines: ReadonlyArray<string>): SdpMediaSection {
  // m=<type> <port> <protocol> <payloadType1> [payloadType2 ...]
  const mParts = mLine.substring(2).split(/\s+/)
  const type = mParts[0] ?? 'unknown'
  const port = parseInt(mParts[1] ?? '0', 10)
  const protocol = mParts[2] ?? 'RTP/AVP'
  const payloadTypes = mParts
    .slice(3)
    .map((p) => parseInt(p, 10))
    .filter((n) => !isNaN(n))

  const primaryPt = payloadTypes[0]

  // Parse a=rtpmap:<pt> <codec>/<clockRate>[/<channels>]
  let codec: string | null = null
  let clockRate: number | null = null
  let channels: number | null = null

  for (const line of lines) {
    const rtpmapMatch = line.match(/^a=rtpmap:(\d+)\s+([^/]+)\/(\d+)(?:\/(\d+))?/)
    if (rtpmapMatch) {
      const pt = parseInt(rtpmapMatch[1]!, 10)
      if (pt === primaryPt) {
        codec = rtpmapMatch[2]!
        clockRate = parseInt(rtpmapMatch[3]!, 10)
        channels = rtpmapMatch[4] ? parseInt(rtpmapMatch[4], 10) : null
      }
    }
  }

  // Fallback for well-known static payload types (no rtpmap line)
  if (!codec && primaryPt !== undefined) {
    const staticCodec = STATIC_PAYLOAD_TYPES.get(primaryPt)
    if (staticCodec) {
      codec = staticCodec.codec
      clockRate = staticCodec.clockRate
      channels = staticCodec.channels
    }
  }

  // Parse a=fmtp:<pt> <key>=<value>;<key>=<value>;...
  const fmtp = parseFmtp(lines, primaryPt)

  // Parse a=control:<url>
  const control = extractAttribute(lines, 'control')

  return { type, port, protocol, payloadTypes, codec, clockRate, channels, fmtp, control, lines }
}

function parseFmtp(
  lines: ReadonlyArray<string>,
  payloadType: number | undefined,
): Record<string, string> {
  const result: Record<string, string> = {}

  for (const line of lines) {
    const fmtpMatch = line.match(/^a=fmtp:(\d+)\s+(.+)/)
    if (!fmtpMatch) continue
    const pt = parseInt(fmtpMatch[1]!, 10)
    if (payloadType !== undefined && pt !== payloadType) continue

    const paramsStr = fmtpMatch[2]!
    // Split on ';' then on first '='
    for (const part of paramsStr.split(/;\s*/)) {
      const eqIdx = part.indexOf('=')
      if (eqIdx > 0) {
        const key = part.substring(0, eqIdx).trim().toLowerCase()
        const value = part.substring(eqIdx + 1).trim()
        result[key] = value
      }
    }
  }

  return result
}

function extractAttribute(lines: ReadonlyArray<string>, name: string): string | null {
  for (const line of lines) {
    if (line.startsWith(`a=${name}:`)) {
      return line.substring(name.length + 3).trim()
    }
  }
  return null
}

/**
 * Extract CodecParams (parameter set buffers) from SDP fmtp.
 *
 * H.264: sprop-parameter-sets=<base64-SPS>,<base64-PPS>
 * H.265: sprop-vps=<base64>; sprop-sps=<base64>; sprop-pps=<base64>
 *
 * Returns null if parameter sets are missing from SDP (some cameras
 * only send them in-band via RTP).
 */
function extractCodecParams(
  codec: 'h264' | 'h265',
  fmtp: Readonly<Record<string, string>>,
): CodecParams | null {
  if (codec === 'h264') {
    const spropSets = fmtp['sprop-parameter-sets']
    if (!spropSets) return null

    const parts = spropSets.split(',').filter((s) => s.length > 0)
    if (parts.length < 2) return null

    const parameterSets = parts.map((p) => Buffer.from(p, 'base64'))
    return { codec, parameterSets }
  }

  // H.265: need all three
  const vpsB64 = fmtp['sprop-vps']
  const spsB64 = fmtp['sprop-sps']
  const ppsB64 = fmtp['sprop-pps']
  if (!vpsB64 || !spsB64 || !ppsB64) return null

  const parameterSets = [
    Buffer.from(vpsB64, 'base64'),
    Buffer.from(spsB64, 'base64'),
    Buffer.from(ppsB64, 'base64'),
  ]
  return { codec, parameterSets }
}

/** Well-known static RTP payload types (RFC 3551). */
const STATIC_PAYLOAD_TYPES = new Map<
  number,
  { codec: string; clockRate: number; channels: number }
>([
  [0, { codec: 'PCMU', clockRate: 8000, channels: 1 }],
  [8, { codec: 'PCMA', clockRate: 8000, channels: 1 }],
])
