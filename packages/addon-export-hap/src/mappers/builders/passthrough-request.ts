/**
 * What HomeKit asks the SHARED stream picker for.
 *
 * ## Why this exists at all
 *
 * `cameraStreams.pickStream` is the one surface every broker consumer scores
 * through, and its docblock names HomeKit among them. HomeKit was the one
 * consumer that never called it: it ranked profile RTSP entries with a second
 * helper of its own and, on 2026-09-17, grew a private resolution rule on top
 * of that. The cap's own `maxHeight` docblock had already written the warning —
 * *"one caller implementing it privately is how a second scoring authority gets
 * born"*.
 *
 * ## The question, and why `null` is a real answer
 *
 * It is always the bypass question: *is there a stream I can forward untouched
 * to this controller?* `allowTranscode: false` makes it that question and
 * nothing else. A `null` answer is not a failure — it means nothing can be
 * forwarded, and the caller then transcodes knowing exactly why.
 *
 * Pure: it builds the ask, it does not make it. The broker is not needed to
 * assert what HomeKit is asking.
 */
import type { PickStreamPreferences, PickStreamRequirements, StreamCodec } from '@camstack/types'

import { TierVideoCodec } from '../../multi-tier/video-stream-tiers.js'

export interface PassthroughRequestInput {
  /** The height the controller NEGOTIATED — the most we may deliver. */
  readonly negotiatedHeight: number
  /** Whether the session was negotiated on Apple's multi-tier RTP service. */
  readonly multiTier: boolean
  /** The codec that service advertised, when it advertised one. */
  readonly codec?: TierVideoCodec
}

export interface PassthroughRequest {
  readonly requirements: PickStreamRequirements
  readonly preferences: PickStreamPreferences
}

export function passthroughRequest(input: PassthroughRequestInput): PassthroughRequest {
  // The classic HAP service renders H.264 and nothing else — HEVC there is a
  // black picture with no error. The multi-tier service advertises
  // `VideoCodecType 2 = H.265`, so a session negotiated on it may take the
  // HEVC untouched, which is the whole transcode that service exists to
  // remove.
  const acceptCodecs: StreamCodec[] = ['h264']
  if (input.multiTier && input.codec !== TierVideoCodec.H264) {
    acceptCodecs.push('h265', 'hevc')
  }

  return {
    requirements: {
      acceptCodecs,
      // The bypass question. See the file header.
      allowTranscode: false,
      // An exporter may never open the camera's own url: the broker dials the
      // camera and everyone else dials its restream. A source with no slot has
      // no restream, so naming it would name something nothing can use.
      requireProfileBound: true,
      // The SAME ceiling `fitsRequestedResolution` enforces after the fact,
      // said here in the picker's own word. The two decide different things —
      // the picker decides which slot wins, that rule decides whether it may
      // be copied — but they state one ceiling, and stating it twice in one
      // vocabulary is what makes them agree by construction. Stated in only
      // one, they agreed because the same person wrote both: "agreeing by
      // luck, not by property", which this repo has already paid for once.
      maxHeight: input.negotiatedHeight,
    },
    preferences: {
      // "The SMALLEST stream at or above the target wins." That is what stops
      // a 3840x2160 slot being forwarded to a 1280x720 request — the overshoot
      // iOS reported losing 52.7 % of on 2026-09-17.
      targetHeight: input.negotiatedHeight,
    },
  }
}
