/**
 * What frame rate do we tell HomeKit we can deliver? (R2)
 *
 * The delegate used to advertise every resolution at 30 fps. That number was
 * invented — there is no probe behind it anywhere in the addon. Measured on
 * the live hub, device 101's Mid 1280×720 slot runs at ~10 fps while High and
 * Low run at ~25, and `startFfmpegForSession` steers a controller that asked
 * for 1280×720 onto Mid *by construction* (`pickPreferredRtspEntry` resolves
 * against the negotiated target resolution). So a controller was told "720p at
 * 30", was handed 10 fps, and tore the session down.
 *
 * `-c:v copy` means we cannot honour a frame rate we do not already have: the
 * only lever is honesty. This module derives the advertised rate from the same
 * two sources the operator sees in the UI, in falling order of authority:
 *
 *   1. `measured`  — `webrtcSession.listStreams().inputFps`, the broker's own
 *                    observation of the camera's actual arrival rate.
 *   2. `published` — `cameraStreams.getCameraStreams().fps`, what the device
 *                    provider declared for the cam-stream the slot is assigned
 *                    to. Used when the broker is cold (`inputFps === 0` means
 *                    "nothing flowing right now", NOT "0 fps").
 *   3. `assumed`   — {@link ASSUMED_FPS}. The last resort, and the ONLY case
 *                    where we are guessing. It is labelled so in the log.
 *
 * Everything here is pure. The probe that fetches the three inputs lives in
 * `camera-streams.ts`; keeping the derivation separate is what makes the slot
 * each advertised resolution resolves to assertable in a unit test against the
 * real picker.
 */
import type { Resolution } from '@homebridge/hap-nodejs'

import { pickPreferredRtspEntry } from '@camstack/types'
import type {
  CamProfile,
  CameraStream,
  ProfileRtspEntry,
  ProfileSlot,
  WebrtcStreamChoice,
} from '@camstack/types'

/**
 * Rate advertised when nothing could be probed. Matches the historical
 * hard-coded value so a device with no broker telemetry behaves exactly as it
 * did before — but the log now says `source=assumed` instead of implying a
 * measurement.
 */
export const ASSUMED_FPS = 30

/** HAP carries the frame rate as a single byte; 30 is the ceiling we support. */
export const MAX_ADVERTISED_FPS = 30

/**
 * Below 1 fps there is no representable integer rate, and rounding 0.4 up to 1
 * would be a lie of the same kind we are removing. Such a reading degrades to
 * {@link ASSUMED_FPS} and is reported as `assumed`.
 */
export const MIN_ADVERTISED_FPS = 1

/** Where an advertised frame rate came from. `assumed` means "not probed". */
export type ProfileFpsSource = 'measured' | 'published' | 'assumed'

export interface ResolvedProfileFps {
  readonly profile: CamProfile
  readonly fps: number
  readonly source: ProfileFpsSource
}

export type ProfileFpsMap = ReadonlyMap<CamProfile, ResolvedProfileFps>

export interface ResolveProfileFpsInput {
  /** `webrtcSession.listStreams` output — carries the broker's `inputFps`. */
  readonly choices: readonly WebrtcStreamChoice[]
  /** `cameraStreams.getBrokerStreams` output — maps a profile to its source. */
  readonly slots: readonly ProfileSlot[]
  /** `cameraStreams.getCameraStreams` output — carries the published `fps`. */
  readonly camStreams: readonly CameraStream[]
}

/** One candidate resolution we may advertise, before a rate is attached. */
export type CandidateResolution = readonly [width: number, height: number]

export interface AdvertisedResolution {
  readonly width: number
  readonly height: number
  readonly fps: number
  /** Slot the START path will dial for this resolution; null when none is publishable. */
  readonly profile: CamProfile | null
  readonly source: ProfileFpsSource
}

export interface DeriveAdvertisedResolutionsInput {
  readonly candidates: readonly CandidateResolution[]
  /** `cameraStreams.getProfileRtspEntries` output. */
  readonly entries: readonly ProfileRtspEntry[]
  readonly deviceId: number
  /** Operator's `streamPreference` — `'auto'` or a profile name. */
  readonly pref: 'auto' | string
  readonly fpsByProfile: ProfileFpsMap
}

/**
 * The resolutions we offer, before rates are attached. Same list the delegate
 * advertised before R2 — only the frame rate changes, so a controller that had
 * already negotiated a resolution keeps finding it.
 */
export const CANDIDATE_RESOLUTIONS: readonly CandidateResolution[] = [
  [1920, 1080],
  [1280, 720],
  [1024, 768],
  [640, 480],
  [640, 360],
  [480, 360],
  [480, 270],
  [320, 240],
  [320, 180],
]

/**
 * Resolve the real frame rate of each profile slot.
 *
 * A slot with no measurement, no publication and no assignment simply does not
 * appear in the map — the caller then advertises {@link ASSUMED_FPS} and says
 * so. Absence is never silently rendered as a number.
 */
export function resolveProfileFps(input: ResolveProfileFpsInput): ProfileFpsMap {
  const publishedByProfile = publishedFpsByProfile(input.slots, input.camStreams)
  const out = new Map<CamProfile, ResolvedProfileFps>()

  for (const choice of input.choices) {
    // `adaptive` and `cam-stream` targets are not profile slots: adaptive has
    // no fixed source, and a pinned cam-stream is not what the exporter dials.
    if (choice.target.kind !== 'profile') continue
    const profile = choice.target.profile
    const measured = clampFps(choice.inputFps)
    if (measured !== null) {
      out.set(profile, { profile, fps: measured, source: 'measured' })
      continue
    }
    const published = clampFps(publishedByProfile.get(profile) ?? null)
    out.set(
      profile,
      published !== null
        ? { profile, fps: published, source: 'published' }
        : { profile, fps: ASSUMED_FPS, source: 'assumed' },
    )
  }

  // A slot the WebRTC facade did not list (cap unavailable, provider missing)
  // can still have a published rate — use it rather than dropping the slot.
  for (const [profile, fps] of publishedByProfile) {
    if (out.has(profile)) continue
    const published = clampFps(fps)
    if (published !== null) out.set(profile, { profile, fps: published, source: 'published' })
  }

  return out
}

/**
 * Attach a frame rate to each candidate resolution by asking the REAL picker
 * which slot the START path would dial for it. That coupling is the point: if
 * the picker's steering changes, the advertisement changes with it instead of
 * drifting into a second, silently different opinion.
 */
export function deriveAdvertisedResolutions(
  input: DeriveAdvertisedResolutionsInput,
): readonly AdvertisedResolution[] {
  const candidates = input.candidates.length > 0 ? input.candidates : CANDIDATE_RESOLUTIONS
  const seen = new Set<string>()
  const out: AdvertisedResolution[] = []

  for (const [width, height] of candidates) {
    const picked = pickPreferredRtspEntry(input.entries, input.pref, input.deviceId, {
      targetResolution: { width, height },
    })
    const profile = picked === null ? null : toCamProfile(picked.profileId)
    const resolved = profile === null ? undefined : input.fpsByProfile.get(profile)
    const advertised: AdvertisedResolution = {
      width,
      height,
      fps: resolved?.fps ?? ASSUMED_FPS,
      profile,
      source: resolved?.source ?? 'assumed',
    }
    const key = `${advertised.width}x${advertised.height}@${advertised.fps}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(advertised)
  }

  return out
}

/** Project onto the `[width, height, fps]` triples hap-nodejs expects. */
export function toHapResolutions(advertised: readonly AdvertisedResolution[]): Resolution[] {
  return advertised.map((a) => [a.width, a.height, a.fps])
}

/** Compact `1280x720@10(measured)` rendering for a single log field. */
export function formatAdvertisedResolutions(
  advertised: readonly AdvertisedResolution[],
): readonly string[] {
  return advertised.map((a) => `${a.width}x${a.height}@${a.fps}/${a.profile ?? '-'}(${a.source})`)
}

function publishedFpsByProfile(
  slots: readonly ProfileSlot[],
  camStreams: readonly CameraStream[],
): ReadonlyMap<CamProfile, number> {
  const fpsByCamStream = new Map<string, number>()
  for (const stream of camStreams) {
    if (typeof stream.fps === 'number') fpsByCamStream.set(stream.camStreamId, stream.fps)
  }
  const out = new Map<CamProfile, number>()
  for (const slot of slots) {
    if (slot.sourceCamStreamId === null) continue
    const fps = fpsByCamStream.get(slot.sourceCamStreamId)
    if (fps !== undefined) out.set(slot.profile, fps)
  }
  return out
}

/**
 * Coerce a probe reading into an advertisable integer rate, or null when the
 * reading carries no information (absent, zero because the broker is idle,
 * negative, NaN, or below the representable floor).
 */
function clampFps(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const floored = Math.floor(value)
  if (floored < MIN_ADVERTISED_FPS) return null
  return Math.min(floored, MAX_ADVERTISED_FPS)
}

const CAM_PROFILES: readonly CamProfile[] = ['high', 'mid', 'low']

/**
 * `PickedStream.profileId` is the brokerId suffix, which for a profile-keyed
 * entry IS the profile name. Anything else (a raw cam-stream id) is not a
 * profile and must not be coerced into one.
 */
function toCamProfile(profileId: string): CamProfile | null {
  return CAM_PROFILES.find((p) => p === profileId) ?? null
}
