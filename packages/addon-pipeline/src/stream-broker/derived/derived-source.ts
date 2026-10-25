import type { AudioCodecTarget, GetStreamWithCodecInput, VideoCodecTarget } from '@camstack/types'
import { z } from 'zod'
import type { DerivedSourceRef, ProfileName } from './cycle-check.js'

export type { DerivedSourceRef, ProfileName }

/**
 * Zod validator for a {@link DerivedSourceRef}. A derived stream's source is
 * dual-mode: either a **profile** slot (the derived follows whatever physical
 * stream that profile is assigned to) or a **camStream** (pinned to a specific
 * physical stream regardless of profile assignment).
 */
export const DerivedSourceRefSchema = z.union([
  z.object({ kind: z.literal('profile'), profile: z.enum(['high', 'mid', 'low']) }),
  z.object({ kind: z.literal('camStream'), camStreamId: z.string() }),
])

/**
 * The `getStreamWithCodec` cap input. Reused (not duplicated) from
 * `@camstack/types` — the derived feeder resolves a source's broker RTSP
 * loopback through the SAME read API the recorder/webrtc-transcode use.
 */
export type GetStreamWithCodecRequest = GetStreamWithCodecInput

/**
 * Sensible defaults for a derived feeder's source read. The feeder does its own
 * transcode downstream — it only needs the source's loopback RTSP, so it reads
 * the source with `copy` video (no re-encode of the source) + `aac` audio,
 * mirroring the recorder's `getStreamWithCodec` call.
 */
const DERIVED_SOURCE_VIDEO_TARGET: VideoCodecTarget = 'copy'
const DERIVED_SOURCE_AUDIO_TARGET: AudioCodecTarget = 'aac'

/**
 * Result of mapping a {@link DerivedSourceRef} to a source read.
 *
 * `getStreamWithCodec` resolves a source ONLY via a `profile` selector — the cap
 * has NO `camStreamId`/`streamId` selector. So a profile source maps to a
 * `ready` request directly, while a physical `camStream` source cannot be
 * expressed as a `getStreamWithCodec` input: it is flagged `needs-camstream-resolver`
 * for the feeder-wiring step to resolve the `camStreamId → broker loopback` path
 * itself (a `camStreamId` names a broker directly, so no profile indirection is
 * needed there).
 */
export type DerivedSourceStreamRequest =
  | { readonly kind: 'ready'; readonly request: GetStreamWithCodecRequest }
  | {
      readonly kind: 'needs-camstream-resolver'
      readonly deviceId: number
      readonly camStreamId: string
      readonly video: VideoCodecTarget
      readonly audio: AudioCodecTarget
    }

/**
 * Pure mapper: a {@link DerivedSourceRef} → the source read the derived feeder
 * needs to reach that source's broker RTSP loopback (never the camera).
 *
 * - `{kind:'profile'}` → a ready `getStreamWithCodec` request using the profile
 *   selector (follows whatever physical stream that profile is assigned to).
 * - `{kind:'camStream'}` → a `needs-camstream-resolver` flag; the cap accepts no
 *   camStream selector, so the caller resolves the `camStreamId → loopback`
 *   directly (see {@link DerivedSourceStreamRequest}).
 */
export function derivedSourceToStreamRequest(
  source: DerivedSourceRef,
  deviceId: number,
): DerivedSourceStreamRequest {
  if (source.kind === 'profile') {
    return {
      kind: 'ready',
      request: {
        deviceId,
        video: DERIVED_SOURCE_VIDEO_TARGET,
        audio: DERIVED_SOURCE_AUDIO_TARGET,
        profile: source.profile,
      },
    }
  }
  return {
    kind: 'needs-camstream-resolver',
    deviceId,
    camStreamId: source.camStreamId,
    video: DERIVED_SOURCE_VIDEO_TARGET,
    audio: DERIVED_SOURCE_AUDIO_TARGET,
  }
}
