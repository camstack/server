/**
 * Shared stream-selection picker for export addons.
 *
 * Both `addon-export-alexa` and `addon-export-hap` resolve the
 * operator's `streamPreference` setting against the broker's RTSP
 * entries before dialling a camera. Each addon used to roll its own:
 * Alexa had `pickPreferredRtspEntry` under `handlers/`, HAP had an
 * inline `"prefer /mid, then /high, then first"` chain inside its
 * camera-streams mapper. The chains drifted (Alexa honoured
 * `streamPreference`, HAP didn't; only Alexa got the smart
 * resolution-targeted auto-pick) and the cross-addon import rule
 * blocks deduping in either direction.
 *
 * Lifting the picker into `@camstack/types` lets every exporter call
 * the same code path with the consumer's target resolution baked into
 * the call site — Alexa passes 1280×720, HomeKit passes 1920×1080,
 * the picker handles the rest.
 *
 * Selection algorithm:
 *   - pref === '<profile>' → profile-keyed entries (from
 *                         `getProfileRtspEntries`) match on `e.profile`;
 *                         legacy raw entries match on the brokerId
 *                         suffix (`brokerId` ENDS WITH `/${pref}`, shape
 *                         `${deviceId}/${camStreamId}`). Addons store the
 *                         bare profile/camStream id in their
 *                         `ExportDeviceSettings.streamPreference`. Falls
 *                         back to 'auto' when no enabled entry matches
 *                         either way.
 *   - pref === 'auto'   → when `targetResolution` is given, pick the
 *                         entry whose source resolution is closest to
 *                         it (prefer ≥ target so the consumer
 *                         downscales instead of upscaling). Without a
 *                         target, fall back to first-enabled. If no
 *                         entry advertises a resolution at all
 *                         (broker hasn't probed yet), also fall back
 *                         to first-enabled so cold start still serves.
 *
 * Returns `null` when nothing is publishable — callers fold that into
 * the consumer's "no stream" error (Alexa: STREAM_TYPE_UNSUPPORTED;
 * HAP: a thrown error inside `startFfmpegForSession`).
 */

import { compareToTarget } from './camera/stream-pick.js'

export interface RtspEntryLike {
  readonly brokerId: string
  readonly url: string
  readonly mutedUrl: string
  readonly enabled: boolean
  readonly codec?: string
  readonly resolution?: { readonly width: number; readonly height: number }
  /**
   * Profile slot this entry serves, set by `getProfileRtspEntries`.
   * When `pref` is a profile ('high'|'mid'|'low') the picker matches on
   * this first, before the legacy brokerId-suffix match.
   */
  readonly profile?: 'high' | 'mid' | 'low'
}

export interface PickedStream {
  readonly brokerId: string
  readonly profileId: string
  readonly url: string
  readonly mutedUrl: string
  readonly enabled: boolean
  readonly codec?: string
  readonly resolution?: { readonly width: number; readonly height: number }
}

export interface PickPreferredOptions {
  /**
   * Consumer's target resolution (Alexa ≈ 1280×720, HomeKit ≈ 1920×1080).
   * When set and `pref === 'auto'`, the picker chooses the entry whose
   * source resolution is closest — prefer ≥ target (downscale ok at
   * the consumer), among the rest pick the largest source still ≤
   * target. When absent, 'auto' falls back to first-enabled.
   */
  readonly targetResolution?: { readonly width: number; readonly height: number }
}

export function pickPreferredRtspEntry(
  entries: readonly RtspEntryLike[],
  pref: 'auto' | string,
  deviceId: number,
  options: PickPreferredOptions = {},
): PickedStream | null {
  if (entries.length === 0) return null
  const prefix = `${deviceId}/`

  const toPicked = (e: RtspEntryLike): PickedStream => ({
    brokerId: e.brokerId,
    profileId: e.brokerId.startsWith(prefix) ? e.brokerId.slice(prefix.length) : e.brokerId,
    url: e.url,
    mutedUrl: e.mutedUrl,
    enabled: e.enabled,
    ...(e.codec !== undefined ? { codec: e.codec } : {}),
    ...(e.resolution !== undefined ? { resolution: e.resolution } : {}),
  })

  if (pref !== 'auto') {
    // Profile-keyed entries (exporter path) match on their `profile`;
    // legacy raw entries match on the brokerId suffix. Either way an
    // explicit pref that isn't currently publishable falls through to
    // the 'auto' resolution-closest pick below.
    const match = entries.find(
      (e) =>
        e.enabled && e.url.length > 0 && (e.profile === pref || e.brokerId === `${prefix}${pref}`),
    )
    if (match) return toPicked(match)
    // Preferred entry missing or disabled — fall through to 'auto'.
  }

  const eligible = entries.filter((e) => e.enabled && e.url.length > 0)
  if (eligible.length === 0) return null

  const target = options.targetResolution
  if (target) {
    const withRes = eligible.filter((e) => e.resolution !== undefined)
    if (withRes.length > 0) {
      const picked = pickClosestResolution(withRes, target)
      if (picked) return toPicked(picked)
    }
  }

  return toPicked(eligible[0]!)
}

/**
 * Pick the entry whose `resolution` is closest to `target`, by the ONE target
 * rule ({@link compareToTarget}): prefer at or above the target so the consumer
 * downscales instead of upscaling; among those the smallest; among the rest the
 * largest.
 *
 * This function used to implement that rule itself, in pixels, while
 * `rankStreams` implemented it again in lines — the same sentence written twice
 * for the same two exporters, agreeing by luck rather than by construction.
 * Only the MEASURE is this picker's own: it compares whole pixel counts because
 * its entries can differ in aspect, where the cap's requirement is stated in p.
 */
function pickClosestResolution<
  T extends { readonly resolution?: { readonly width: number; readonly height: number } },
>(
  entries: readonly T[],
  target: { readonly width: number; readonly height: number },
): T | undefined {
  const targetPixels = target.width * target.height
  const withPixels = entries.flatMap((entry) =>
    entry.resolution === undefined
      ? []
      : [{ entry, pixels: entry.resolution.width * entry.resolution.height }],
  )
  const sorted = [...withPixels].sort((a, b) => compareToTarget(a.pixels, b.pixels, targetPixels))
  return sorted[0]?.entry
}
