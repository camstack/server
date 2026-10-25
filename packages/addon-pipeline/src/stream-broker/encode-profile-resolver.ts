import type { EncodeProfile } from '@camstack/types'

/**
 * Resolve an EncodeProfile from an optional persisted override and a
 * consumer-baked default.
 *
 *   override → consumerDefault (by reference)
 *
 * Pure function. The override-or-not decision is local to the caller.
 * In practice `withSourceResolution` adapts a base `EncodeProfile` to a
 * probed source resolution; the WebRTC path passes
 * `WEBRTC_FALLBACK_PROFILE` as that base. The preset library is
 * intentionally NOT a resolver parameter — the snapshot-semantics rule
 * means a supplied override carries its own materialised profile.
 */
export function resolveEncodeProfile(
  override: EncodeProfile | undefined,
  consumerDefault: EncodeProfile,
): EncodeProfile {
  return override ?? consumerDefault
}

/**
 * Adapt a consumer's baked default to a publisher-probed source shape.
 *
 * When the probed source advertises both width and height, the returned
 * profile overrides `consumerDefault.video.{width,height}` so the
 * forced-transcode path scales to the source's real resolution instead
 * of the baked 720p — a 4K H.265 camera served to a no-HW-HEVC browser
 * stays 4K H.264 on the wire instead of dropping to 720p.
 *
 * Returns the consumer default by reference when the probed source is
 * absent or carries no dimensions, so callers can rely on identity for
 * "no smart fallback applied" checks.
 *
 * Other video fields (codec, profile, fps, bitrate, GOP, preset, tune)
 * are NOT touched — those encode the consumer's protocol contract, not
 * the source. Audio is left untouched for the same reason.
 *
 * Pure function. The decision to apply this fallback (only when the
 * operator hasn't set an explicit override) lives at the call site —
 * see `WebrtcSessionProvider.resolveTranscodeProfile`.
 */
export function withSourceResolution(
  consumerDefault: EncodeProfile,
  probedSource: EncodeProfile | undefined,
): EncodeProfile {
  const probedWidth = probedSource?.video.width
  const probedHeight = probedSource?.video.height
  if (probedWidth === undefined || probedHeight === undefined) return consumerDefault
  return {
    ...consumerDefault,
    video: { ...consumerDefault.video, width: probedWidth, height: probedHeight },
  }
}
