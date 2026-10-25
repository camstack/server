/**
 * The ONE home for live-egress encode constants.
 *
 * Before this file there were five sets, in four packages, that nobody could
 * diff: the WebRTC fallback, Alexa's "fallback", the transcode-down ceiling,
 * the broker's audio presets, and HomeKit's inline block. Three of them
 * disagreed about Opus channel count alone. They live here now because the
 * consumers are separate ADDONS and addons may never import each other —
 * `@camstack/types` is the only legal shared home.
 *
 * ## What changed value, and what kept a deliberate divergence
 *
 * KEPT, with the reason:
 * - **VBV window.** HomeKit uses a ONE-second window; the browser and Alexa
 *   use TWO. HomeKit's link budget is enforced per second by the controller,
 *   so a keyframe allowed to borrow from the next second overshoots and the
 *   iOS client drops the stream. A browser wants the opposite: let a keyframe
 *   spike, keep the average. Encoded as {@link FfmpegRateControl}, not as two
 *   copies of a number.
 * - **`preset`.** HomeKit and the browser use `ultrafast` (the encoder is on
 *   the interactive path); Alexa uses `veryfast` (Echo tolerates ~200 ms more
 *   latency and the extra quality is visible on a 10" panel).
 * - **`-bsf:v dump_extra`** is HomeKit-only on BOTH the copy and encode
 *   branches: HAP negotiates its own SDP and cannot carry out-of-band
 *   extradata. Nothing else needs it, and emitting it elsewhere costs bytes.
 *
 * CHANGED — the divergences that were accidents:
 * - **Opus channels.** Was 2 (broker preset), 1 (Alexa), 1 (HomeKit). Now 1
 *   everywhere: every consumer here is a camera microphone, which is mono at
 *   the source, and encoding a duplicated second channel spent bitrate on
 *   nothing. The broker's 2 was the outlier and it is the one that changed.
 * - **Alexa gained `level: '3.1'`.** Its SDP advertises `profile-level-id=
 *   42e01f` and its encoder was unconstrained. Now it matches.
 * - **Alexa GOP.** Was 25 frames at 25 fps (1 s); the browser is 30 at 25 fps
 *   (1.2 s). Both are now expressed as `gopSeconds` × fps so the intent is
 *   legible; Alexa's numeric GOP is unchanged, the browser's rounds to 30.
 */
import type { EncodeProfile } from '../encode-profile.js'
import type { FfmpegAudioEncodePlan, FfmpegRateControl } from './invocation.js'

/**
 * The shape every live egress starts from: H.264 Baseline 3.1 at 720p25.
 * Baseline because it is the one profile every consumer in this repo decodes
 * (Echo, iOS, an old browser); 3.1 because that is what the SDPs advertise.
 */
export const BASE_LIVE_EGRESS_PROFILE: EncodeProfile = {
  video: {
    codec: 'h264',
    profile: 'baseline',
    level: '3.1',
    width: 1280,
    height: 720,
    fps: 25,
    bitrateKbps: 2500,
    gopFrames: 25,
    bf: 0,
    preset: 'veryfast',
    tune: 'zerolatency',
  },
  audio: 'passthrough',
}

/**
 * The browser WebRTC viewer's transcode profile. Used only when the broker
 * MUST spawn ffmpeg (source codec ∉ the browser-accepted set — an H.265 source
 * on an H.264-only browser). Audio is `passthrough` because werift carries the
 * audio plane out-of-band; putting it in the video pipeline would encode a
 * track nothing reads.
 */
export const WEBRTC_EGRESS_PROFILE: EncodeProfile = {
  ...BASE_LIVE_EGRESS_PROFILE,
  video: {
    ...BASE_LIVE_EGRESS_PROFILE.video,
    bitrateKbps: 3000,
    gopFrames: 30,
    // The encoder is on the interactive path — a viewer notices latency long
    // before it notices the quality `veryfast` would buy.
    preset: 'ultrafast',
  },
  audio: 'passthrough',
}

/**
 * Alexa's egress profile. Alexa's audio ALSO rides the WebRTC session's own
 * audio plane (out-of-band), so this is `passthrough` exactly like the browser
 * — see the ADR for why the previous in-band Opus was encoded and discarded.
 */
/**
 * Alexa's egress asks for OPUS, and that is a change with a history.
 *
 * The previous profile encoded Opus IN-BAND into an MPEG-TS, where it was
 * discarded: Opus is `stream_type 0x06` and the broker's demuxer maps only
 * `0x0f` (aac), `0x03`/`0x04` (mp2) and `0x81` (ac3). Every frame it produced
 * died at the demuxer, so the encode was replaced with `passthrough` — correct,
 * because paying libopus for nothing is worse than silence.
 *
 * But `passthrough` means the egress emits NO audio at all, and Alexa's audio
 * does not arrive by magic: it rides the published stream, which is what the
 * WebRTC session dials. So the Echo had video and silence either way.
 *
 * Opus here now reaches the egress AUDIO SIDECAR — a separate RTP leg the
 * restreamer grafts onto its SDP — which never touches the MPEG-TS demuxer that
 * killed the in-band attempt. Same codec, different plane, and this one the
 * consumer can actually negotiate.
 */
export const ALEXA_EGRESS_PROFILE: EncodeProfile = {
  ...BASE_LIVE_EGRESS_PROFILE,
  audio: { codec: 'opus' },
  video: { ...BASE_LIVE_EGRESS_PROFILE.video, singleSlicePerFrame: true },
}

/** VBV window for a consumer whose budget is enforced per second (HomeKit). */
export const RATE_CONTROL_TIGHT: FfmpegRateControl = { kind: 'cbr', vbvSeconds: 1 }

/** VBV window for a consumer that tolerates a keyframe spike (browser, Echo). */
export const RATE_CONTROL_RELAXED: FfmpegRateControl = { kind: 'cap', vbvSeconds: 2 }

/**
 * Transcode-DOWN ceiling: the shape a remote/unhealthy WebRTC session is
 * reduced to. 360p / 400 kbps is the `low` rung of the adaptive ladder — a
 * session steered here is already failing, so the ceiling is chosen to survive
 * a bad link, not to look good.
 */
export const TRANSCODE_DOWN_MAX_HEIGHT = 360
export const TRANSCODE_DOWN_MAX_BITRATE_KBPS = 400

/**
 * Camera-microphone audio, per codec. Defined in `./invocation.js` (an import
 * cycle otherwise) and re-exported here, which is where to read it.
 */
export { AUDIO_PRESETS } from './invocation.js'

/**
 * HomeKit's two-way audio leg. `lowdelay` + a short frame duration because the
 * leg is interactive; `globalHeader` because HAP owns the SDP and ffmpeg must
 * not put extradata in-band. `sampleRateHz` and `frameDurationMs` are
 * NEGOTIATED per session — the controller picks them — so they are absent here
 * and filled in by the caller.
 */
export const HAP_AUDIO_BITRATE_KBPS = 24

export const HAP_AUDIO_BASE: FfmpegAudioEncodePlan = {
  kind: 'encode',
  codec: 'opus',
  bitrateKbps: HAP_AUDIO_BITRATE_KBPS,
  channels: 1,
  application: 'lowdelay',
  globalHeader: true,
  filter: 'aresample=async=1000:first_pts=0',
}

/** HomeKit's `-bufsize` for the audio plane — four seconds of its 24 kbps. */
export const HAP_AUDIO_VBV_KBITS = HAP_AUDIO_BITRATE_KBPS * 4

/** Seconds between forced IDRs on a HomeKit transcode. */
export const HAP_KEYFRAME_INTERVAL_SEC = 4
