/**
 * Single source of truth for the Wyze provider addon id. Must match the
 * `camstack.addons[0].id` in `package.json` — both the provider's
 * `addonId` field and `device.online`/`device.offline` event source tags
 * are correlated by the device-manager + alert center on this exact
 * string.
 */
export const WYZE_ADDON_ID = 'provider-wyze'

/**
 * The single native cam-stream id every Wyze camera publishes. Wyze
 * exposes ONE physical P2P stream per resolution selection (no separate
 * sub-stream URL like RTSP) — the broker derives high/mid/low from the
 * chosen `frameSize`. So the catalog is a single `native:main` entry.
 */
export const WYZE_NATIVE_STREAM_ID = 'native:main'

/**
 * Sentinel URL prefix for the lazy-publish `pull-rfc4571` path. The broker
 * detects this on dial and emits
 * `StreamBrokerOnRequestStreamSourceRefresh` instead of trying to connect;
 * the provider responds by materializing the real loopback `tcp://` URL.
 * Mirrors Reolink's `lazy:rfc4571:<camStreamId>` sentinel.
 */
export function buildLazyRfc4571Url(camStreamId: string): string {
  // Encode so the sentinel is a clean URL component (mirrors Reolink).
  // The broker matches on the `lazy:rfc4571:` PREFIX, not the suffix.
  return `lazy:rfc4571:${encodeURIComponent(camStreamId)}`
}

/**
 * Minimal synthetic SDP for the lazy catalog entry, before the real SDP
 * (with SPS/PPS extracted from the first live keyframe) is materialised.
 * The real SDP replaces this at dial time via `materializeStreamSocket`.
 * Both H264 and H265 decoders pick up parameter sets from in-band NALs,
 * so a `sprop`-less synthetic SDP is sufficient for the placeholder.
 */
export function buildSyntheticSdp(codec: 'h264' | 'h265'): string {
  const videoCodec = codec === 'h265' ? 'H265' : 'H264'
  let out = 'v=0\r\n'
  out += 'o=- 0 0 IN IP4 0.0.0.0\r\n'
  out += 's=Wyze\r\n'
  out += 't=0 0\r\n'
  out += 'm=video 0 RTP/AVP 96\r\n'
  out += 'c=IN IP4 0.0.0.0\r\n'
  out += `a=rtpmap:96 ${videoCodec}/90000\r\n`
  if (codec === 'h264') {
    out += 'a=fmtp:96 packetization-mode=1\r\n'
  }
  return out
}

/**
 * Wyze `frameSize` selector — the camera-side resolution. `0` = 1080p
 * (the default we ship), the others are the lib's documented values.
 */
export const WYZE_FRAME_SIZE = {
  fhd: 0, // 1080p
  low: 1, // 360p
  hd: 2, // 720p
  qhd: 3, // 2K
} as const

/**
 * Wyze `bitrate` selector. `0xF0` = max (the lib default), `0x3C` = SD.
 */
export const WYZE_BITRATE = {
  max: 0xf0,
  sd: 0x3c,
} as const
