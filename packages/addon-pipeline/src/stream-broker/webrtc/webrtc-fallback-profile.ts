import type { EncodeProfile } from '@camstack/types'

/**
 * Hardcoded fallback encode profile for the WebRTC viewer path. Used only
 * when the broker must spawn ffmpeg (source codec ∉ the browser-accepted
 * set, e.g. H.265 source on an H.264-only browser). Replaces the former
 * operator-configurable `streamWebrtcParams` override + `WEBRTC_BAKED_DEFAULT`
 * preset. Bit-identical to the old `web-default` profile.
 */
export const WEBRTC_FALLBACK_PROFILE: EncodeProfile = {
  video: {
    codec: 'h264',
    profile: 'baseline',
    width: 1280,
    height: 720,
    fps: 25,
    bitrateKbps: 3000,
    gopFrames: 30,
    bf: 0,
    preset: 'ultrafast',
    tune: 'zerolatency',
  },
  audio: 'passthrough',
}
