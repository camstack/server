/**
 * Build a synthetic SDP for `pull-rfc4571` entries from device-side
 * metadata (Reolink `getStreamMetadata` cmd_id 56) WITHOUT opening an
 * upstream streaming session.
 *
 * The standard Reolink rfc4571 path (in `nodelink-js`) builds SDP from
 * the actual H.264/H.265 SPS/PPS bytes extracted from the first IDR
 * frame of the live stream — which requires the upstream Baichuan
 * streaming session to be open. That eager open is precisely what we
 * want to avoid for hub-children: the lib's session table on the NVR
 * fills with stale sessions every time we adopt + release.
 *
 * This builder produces SDP with:
 *   - codec rtpmap (h264 → 96 / h265 → 96)
 *   - audio rtpmap (AAC → 97 with Reolink-standard 16kHz mono)
 *   - fmtp WITHOUT `sprop-parameter-sets` / `sprop-vps/sps/pps`
 *
 * The lib's `Rfc4571Muxer.sendCachedVideoConfigToClient` learns SPS/PPS
 * (and VPS for H.265) from the first IDR access unit it forwards and
 * primes new clients with cached config bytes via in-band STAP-A or
 * single NAL packets — so downstream consumers (WebRTC peers, RTSP
 * restreamer) see decoder-ready streams within one keyframe of
 * subscribing, even though the SDP they negotiated lacks `sprop-*`.
 *
 * Defaults match the Reolink standard codec config: AAC-LC, 16000Hz
 * mono. Cameras that stream a different audio config still work — the
 * `Rfc4571Muxer.sendAudioAdtsFrame` parses the ADTS header on every
 * frame and re-derives the config in the data path.
 */

const VIDEO_PT = 96
const AUDIO_PT = 97

/**
 * Build SDP from a Reolink `StreamMetadata.videoEncType` + audio flags.
 * Both H.264 and H.265 are supported; unknown codecs default to H.264.
 *
 * `audioEnabled` toggles the audio media section. When false, the SDP
 * declares video only — matches what the rfc4571 server emits when the
 * camera reports `audio: 0`.
 */
export function buildSyntheticRfc4571Sdp(input: {
  readonly videoEncType: string // 'H.264' | 'H.265' | 'h264' | 'h265' | etc.
  readonly audioEnabled: boolean
  /** AAC sample rate — Reolink standard: 16000 Hz. Override only when
   *  the camera reports something different in `getEnc` audio block. */
  readonly audioSampleRate?: number
  /** AAC channel count — Reolink standard: 1 (mono). */
  readonly audioChannels?: number
}): string {
  const enc = String(input.videoEncType ?? '').toLowerCase()
  const isH265 = enc.includes('265') || enc.includes('hevc')
  const videoCodec = isH265 ? 'H265' : 'H264'

  const sampleRate = input.audioSampleRate ?? 16000
  const channels = input.audioChannels ?? 1

  let out = 'v=0\r\n'
  out += 'o=- 0 0 IN IP4 0.0.0.0\r\n'
  out += 's=No Name\r\n'
  out += 't=0 0\r\n'

  out += `m=video 0 RTP/AVP ${VIDEO_PT}\r\n`
  out += 'c=IN IP4 0.0.0.0\r\n'
  out += `a=rtpmap:${VIDEO_PT} ${videoCodec}/90000\r\n`
  if (!isH265) {
    // H.264 packetization-mode=1 = single NAL + STAP-A + FU-A, the
    // most common mode the rfc4571 server emits. No sprop-parameter-sets
    // — the muxer primes clients in-band on first IDR.
    out += `a=fmtp:${VIDEO_PT} packetization-mode=1\r\n`
  }
  // H.265: no fmtp without sprop-vps/sps/pps. Decoders accept this and
  // pick up VPS/SPS/PPS from in-band IRAP NALs.

  if (input.audioEnabled) {
    out += `m=audio 0 RTP/AVP ${AUDIO_PT}\r\n`
    out += 'c=IN IP4 0.0.0.0\r\n'
    out += 'b=AS:128\r\n'
    out += `a=rtpmap:${AUDIO_PT} MPEG4-GENERIC/${sampleRate}/${channels}\r\n`
    // AAC-hbr generic config without explicit `config=` hex — the muxer
    // adapts to the camera's actual ADTS-derived config on every frame.
    out += `a=fmtp:${AUDIO_PT} profile-level-id=1; mode=AAC-hbr; sizelength=13; indexlength=3; indexdeltalength=3\r\n`
  }

  return out
}

/**
 * Sentinel URL used as a placeholder before the rfc4571 server is
 * materialized. The broker detects this prefix in `startRfc4571Reader`
 * and triggers `notifySourceRefresh` instead of attempting to connect
 * — the publisher's listener responds by calling
 * `materializeStreamSocket(camStreamId)` which opens the real socket
 * and re-publishes the entry with the actual `tcp://...` URL.
 *
 * Format: `lazy:rfc4571:<camStreamId>` — opaque to anything that
 * doesn't know to look for it. `new URL(...)` parses it cleanly so the
 * reader's constructor doesn't synchronously throw.
 */
export function buildLazyRfc4571Url(camStreamId: string): string {
  // Normalise camStreamId so it's a safe URL component (the broker
  // matches on the prefix, not the suffix, but keeping it readable
  // helps log diagnostics).
  return `lazy:rfc4571:${encodeURIComponent(camStreamId)}`
}

export const LAZY_RFC4571_URL_PREFIX = 'lazy:rfc4571:'
