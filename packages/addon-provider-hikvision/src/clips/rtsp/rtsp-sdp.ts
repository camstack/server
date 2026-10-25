/**
 * The SDP a Hikvision replay `DESCRIBE` answers, parsed into the two things a
 * session needs: which tracks exist, and how to address each one.
 *
 * Pure. No socket, no logger, no camera.
 *
 * ## Why the session-level `a=control` is not a track
 *
 * Measured on 1436 and 3833 (2026-09-22): the line before the first `m=` is
 * the AGGREGATE URL, and `SETUP` on it answers **415 Unsupported Media Type**
 * — after which the camera closes the socket, so the mistake costs the whole
 * session and not just the request. Only the controls that belong to a media
 * section are addressable, which is why this parser splits on `m=` first and
 * never collects a control it has not seen a media line for.
 *
 * ## Why the codec comes from `rtpmap` and not from the search
 *
 * `ContentMgmt/search` answers `codecType: H.264-BP` for media that is H.265
 * — measured, and stated in the feasibility note. The SDP's `a=rtpmap:96
 * H265/90000` is the camera describing the very bytes it is about to send, so
 * it is what the demuxer is named from. `record/tracks` agrees; `search` does
 * not, and neither of the two that agree is ever overridden by the one that
 * does not.
 */

/** A media codec this provider can carry to ffmpeg, from `a=rtpmap`. */
export type RtspVideoCodec = 'h264' | 'h265'
export type RtspAudioCodec = 'pcmu'

export interface RtspVideoTrack {
  readonly kind: 'video'
  readonly codec: RtspVideoCodec
  readonly payloadType: number
  /** RTP clock, from `a=rtpmap`. 90 000 on every measured camera. */
  readonly clockRate: number
  /** Absolute or relative `a=control` — the URL `SETUP` names. */
  readonly control: string
  /**
   * The VPS / SPS / PPS the camera advertises, already base64-DECODED, in the
   * order they must be prepended to the elementary stream.
   *
   * A replay's first RTP packets do not always repeat the parameter sets, and
   * a decoder handed an IDR with no SPS produces nothing while reporting
   * nothing. Carried here so the producer can prepend them once.
   */
  readonly parameterSets: readonly Buffer[]
}

export interface RtspAudioTrack {
  readonly kind: 'audio'
  readonly codec: RtspAudioCodec
  readonly payloadType: number
  readonly clockRate: number
  readonly control: string
}

export type RtspTrack = RtspVideoTrack | RtspAudioTrack

export interface RtspSessionDescription {
  readonly tracks: readonly RtspTrack[]
  /**
   * Media sections this parser saw and could NOT carry, by their `m=` line.
   *
   * Reported rather than dropped: a track nobody follows is a silence (or a
   * missing picture) somebody has to be able to account for, and an empty
   * array is the honest way to say "nothing was skipped".
   */
  readonly unsupported: readonly string[]
}

interface MediaSection {
  readonly mLine: string
  readonly attributes: readonly string[]
}

/** Split an SDP body into its session part and one section per `m=` line. */
function sectionsOf(sdp: string): readonly MediaSection[] {
  const lines = sdp.split(/\r?\n/)
  const out: MediaSection[] = []
  let current: { mLine: string; attributes: string[] } | null = null
  for (const line of lines) {
    if (line.startsWith('m=')) {
      if (current !== null) out.push({ mLine: current.mLine, attributes: current.attributes })
      current = { mLine: line, attributes: [] }
      continue
    }
    if (current !== null) current.attributes.push(line)
  }
  if (current !== null) out.push({ mLine: current.mLine, attributes: current.attributes })
  return out
}

function attribute(section: MediaSection, name: string): string | undefined {
  const prefix = `a=${name}:`
  return section.attributes
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim()
}

/** `a=fmtp:96 sprop-vps=…; sprop-sps=…; sprop-pps=…` → the decoded NALs. */
function parameterSetsOf(section: MediaSection): readonly Buffer[] {
  const fmtp = section.attributes.find((line) => line.startsWith('a=fmtp:'))
  if (fmtp === undefined) return []
  const out: Buffer[] = []
  // Order matters: VPS, then SPS, then PPS, whatever order the camera spelled
  // them in — a decoder reads them in that order and nothing re-sorts later.
  for (const key of ['sprop-vps', 'sprop-sps', 'sprop-pps', 'sprop-parameter-sets']) {
    const match = new RegExp(`${key}=([^;\\s]+)`).exec(fmtp)
    if (match === null) continue
    for (const encoded of (match[1] ?? '').split(',')) {
      if (encoded === '') continue
      const bytes = Buffer.from(encoded, 'base64')
      if (bytes.byteLength > 0) out.push(bytes)
    }
  }
  return out
}

function videoCodecOf(rtpmap: string | undefined): RtspVideoCodec | null {
  if (rtpmap === undefined) return null
  const name = rtpmap.split(' ')[1]?.split('/')[0]?.toUpperCase()
  if (name === 'H265' || name === 'HEVC') return 'h265'
  if (name === 'H264') return 'h264'
  return null
}

function clockRateOf(rtpmap: string | undefined, fallback: number): number {
  const rate = Number(rtpmap?.split(' ')[1]?.split('/')[1])
  return Number.isFinite(rate) && rate > 0 ? rate : fallback
}

function payloadTypeOf(rtpmap: string | undefined, mLine: string): number {
  const fromMap = Number(rtpmap?.split(' ')[0])
  if (Number.isInteger(fromMap) && fromMap >= 0) return fromMap
  // No `a=rtpmap` at all is legal for a STATIC payload type, and PCMU is the
  // one this fleet serves: the `m=audio 0 RTP/AVP 0` line carries it.
  const fromM = Number(mLine.split(' ')[3])
  return Number.isInteger(fromM) && fromM >= 0 ? fromM : -1
}

/**
 * Parse a replay SDP.
 *
 * Never throws: an SDP that describes nothing this provider can carry answers
 * with no tracks and every skipped `m=` line named, because "the camera
 * answered something we cannot play" and "the camera answered nothing" are
 * different facts and a caller has to be able to say which.
 */
export function parseRtspSdp(sdp: string): RtspSessionDescription {
  const tracks: RtspTrack[] = []
  const unsupported: string[] = []
  for (const section of sectionsOf(sdp)) {
    const control = attribute(section, 'control')
    const rtpmap = section.attributes
      .find((l) => l.startsWith('a=rtpmap:'))
      ?.slice(9)
      .trim()
    if (control === undefined || control === '*') {
      unsupported.push(section.mLine)
      continue
    }
    if (section.mLine.startsWith('m=video')) {
      const codec = videoCodecOf(rtpmap)
      if (codec === null) {
        unsupported.push(section.mLine)
        continue
      }
      tracks.push({
        kind: 'video',
        codec,
        payloadType: payloadTypeOf(rtpmap, section.mLine),
        clockRate: clockRateOf(rtpmap, 90_000),
        control,
        parameterSets: parameterSetsOf(section),
      })
      continue
    }
    if (section.mLine.startsWith('m=audio')) {
      const name = rtpmap?.split(' ')[1]?.split('/')[0]?.toUpperCase()
      const payloadType = payloadTypeOf(rtpmap, section.mLine)
      // PCMU is payload type 0 by the static table, and this firmware omits
      // nothing — but a camera that renamed it would still be µ-law, and a
      // camera that offers AAC must be named rather than mis-decoded.
      if (name !== undefined && name !== 'PCMU') {
        unsupported.push(section.mLine)
        continue
      }
      if (name === undefined && payloadType !== 0) {
        unsupported.push(section.mLine)
        continue
      }
      tracks.push({
        kind: 'audio',
        codec: 'pcmu',
        payloadType,
        clockRate: clockRateOf(rtpmap, 8_000),
        control,
      })
      continue
    }
    unsupported.push(section.mLine)
  }
  return { tracks, unsupported }
}

/**
 * The absolute URL to `SETUP` for a track.
 *
 * Hikvision answers ABSOLUTE controls (measured on both cameras), which is the
 * easy case. A relative one is joined onto the session URL the way RFC 2326
 * says, with the replay's query string preserved — a control joined without it
 * addresses a LIVE track on this firmware, which is the same recording at the
 * wrong moment and would be indistinguishable from a working seek.
 */
export function resolveControlUrl(sessionUrl: string, control: string): string {
  if (control.startsWith('rtsp://') || control.startsWith('rtsps://')) return control
  const query = sessionUrl.indexOf('?')
  const base = query === -1 ? sessionUrl : sessionUrl.slice(0, query)
  const search = query === -1 ? '' : sessionUrl.slice(query)
  const joined = base.endsWith('/') ? `${base}${control}` : `${base}/${control}`
  return `${joined}${search}`
}
