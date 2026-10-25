/**
 * Camera-stream id format surfaced via `publishCameraStream`.
 *
 * Reolink cameras typically expose the same logical stream (main/sub/ext)
 * over THREE different containers — native Baichuan push, RTSP, RTMP. We
 * publish all available containers so the operator can pick which one the
 * broker should consume; the camStreamId carries the container kind as a
 * prefix to keep them disambiguated:
 *
 *   - `native:main`, `native:sub`, `native:ext` — Baichuan RFC 4571 (loopback TCP)
 *   - `rtsp:main`,   `rtsp:sub`,   `rtsp:ext`   — RTSP pull (URL on stream)
 *   - `rtmp:main`,   `rtmp:sub`,   `rtmp:ext`   — RTMP pull (URL on stream)
 *   - `flv:main`,    `flv:sub`,    `flv:ext`    — HTTP-FLV pull (Baichuan media
 *     port, app `bcs`; always ingested via the broker's ffmpeg source reader)
 *
 * NVR / Hub devices (multi-channel) interleave the channel after the kind:
 *
 *   - `native:ch0-main`, `native:ch0-sub`, `native:ch1-main`, …
 *   - `rtsp:ch0-main`, …
 */
export type ReolinkStreamProfile = 'main' | 'sub' | 'ext'
export type ReolinkStreamKind = 'native' | 'rtsp' | 'rtmp' | 'flv'

export interface StreamIdParts {
  readonly kind: ReolinkStreamKind
  readonly channel: number
  readonly profile: ReolinkStreamProfile
}

const KIND_RE = /^(native|rtsp|rtmp|flv):(.+)$/
const CH_PROFILE_RE = /^ch(\d+)-(main|sub|ext)$/
const PROFILE_ONLY_RE = /^(main|sub|ext)$/

/**
 * Build a camStreamId from the (kind, channel, profile) tuple. Single-channel
 * devices omit the `ch{N}-` infix; NVR / Hub include it so per-channel
 * routing survives the round-trip through the broker.
 */
export function buildCamStreamId(
  kind: ReolinkStreamKind,
  channel: number,
  profile: ReolinkStreamProfile,
  channelCount: number,
): string {
  if (channelCount > 1) return `${kind}:ch${channel}-${profile}`
  return `${kind}:${profile}`
}

/**
 * Parse a Reolink camStreamId back to its (kind, channel, profile) tuple.
 * Returns `null` if the id does not match our format — the demand handler
 * uses this to ignore non-native streams (broker pulls those directly).
 */
export function parseCamStreamId(
  camStreamId: string,
  defaultChannel: number,
): StreamIdParts | null {
  const m = KIND_RE.exec(camStreamId)
  if (!m) return null
  const kind = m[1] as ReolinkStreamKind
  const rest = m[2]!
  const ch = CH_PROFILE_RE.exec(rest)
  if (ch) {
    return {
      kind,
      channel: parseInt(ch[1]!, 10),
      profile: ch[2] as ReolinkStreamProfile,
    }
  }
  const p = PROFILE_ONLY_RE.exec(rest)
  if (p) {
    return {
      kind,
      channel: defaultChannel,
      profile: p[1] as ReolinkStreamProfile,
    }
  }
  return null
}

/**
 * Minimal duck-type for `streamLabel` — accepts any of:
 *   - `ReolinkSupportedStream` from the lib (`buildVideoStreamOptions` result)
 *   - any object that exposes the same three field names
 *
 * Keeping the parameter loose means the caller can pass the lib's
 * own structures without an adapter. We only read `profile`, `channel`,
 * and `lens`.
 */
export interface StreamLabelInput {
  readonly profile: ReolinkStreamProfile
  readonly channel?: number
  readonly lens?: 'wide' | 'telephoto' | 'composite'
}

/** Render a human-readable label for the device-settings dropdown. */
export function streamLabel(s: StreamLabelInput, kind?: ReolinkStreamKind): string {
  const parts: string[] = []
  if (kind) parts.push(kindLabel(kind))
  if (s.channel !== undefined) parts.push(`Ch${s.channel}`)
  parts.push(s.profile.charAt(0).toUpperCase() + s.profile.slice(1))
  if (s.lens && s.lens !== 'wide') parts.push(`(${s.lens})`)
  return parts.join(' ')
}

function kindLabel(kind: ReolinkStreamKind): string {
  switch (kind) {
    case 'native':
      return 'Native'
    case 'rtsp':
      return 'RTSP'
    case 'rtmp':
      return 'RTMP'
    case 'flv':
      return 'FLV'
  }
}

/**
 * Synthetic native cam-stream id list used by `getStreamSources()` to
 * advertise the device's expected stream shape before the lib has been
 * called. `publishToBroker` ignores this — it always uses the live
 * result of `buildVideoStreamOptions()` instead.
 */
export function buildStreamIds(channelCount: number): ReadonlyArray<{ id: string; label: string }> {
  if (channelCount <= 1) {
    return [
      { id: 'native:main', label: 'Native Main' },
      { id: 'native:sub', label: 'Native Sub' },
    ]
  }
  const out: Array<{ id: string; label: string }> = []
  for (let ch = 0; ch < channelCount; ch++) {
    out.push({ id: `native:ch${ch}-main`, label: `Native Ch${ch} Main` })
    out.push({ id: `native:ch${ch}-sub`, label: `Native Ch${ch} Sub` })
  }
  return out
}
