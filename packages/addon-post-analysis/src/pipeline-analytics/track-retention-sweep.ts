/**
 * Periodic track retention sweep (design §6) — the piece that makes retention
 * actually BOUNDED. Without it, `pruneTracksBefore` only runs when something
 * calls it; this sweep ages persisted tracks out on the provider's existing
 * retention interval.
 *
 * The cutoff is the device's ONE retention window (`retention-policy.ts`:
 * `retentionMode` + `trackRetentionDays`, default 7 days; `0` = keep forever →
 * the device is skipped). Enrolled gallery is exempt by the cascade store layer
 * (design §4), not here.
 *
 * **There is no settings parsing in this file.** There used to be: a second
 * `TrackRetentionSettingsSchema` declaring `trackRetentionDays` with its own
 * default, plus `resolveTrackRetentionDays` and `trackRetentionCutoff`. None of
 * the three had a production caller — the sweep takes a resolved cutoff — so
 * the operator's one knob had TWO parsers and only one of them was ever read.
 * A second reader of the same setting is the same defect as a setting with no
 * reader, just harder to see, so it is gone (D62). `retention-policy.ts` is the
 * only place a retention setting is parsed.
 *
 * Kept as a pure, dependency-injected function so the loop is unit-testable
 * without booting the addon.
 */
import type { TrackCascadeCounts } from '@camstack/types'

export interface TrackRetentionSweepDeps {
  /** The device set to sweep — devices that have persisted tracks. */
  readonly listDeviceIds: () => Promise<readonly number[]>
  /** The device's ONE retention window (follow-recordings horizon or the custom
   *  day window). `null` = keep forever, the device is skipped. */
  readonly resolveCutoffMs: (deviceId: number, nowMs: number) => Promise<number | null>
  /** The track-centric prune entry point (design §5.1). */
  readonly pruneTracksBefore: (deviceId: number, cutoffMs: number) => Promise<TrackCascadeCounts>
  readonly now: () => number
  /** Optional per-device failure sink (logging). */
  readonly onError?: (deviceId: number, err: unknown) => void
}

/**
 * Sweep every device with persisted tracks: skip retention-disabled devices,
 * prune the rest at `now − retentionMs`. Per-device ISOLATED — one bad device
 * never aborts the sweep. Returns the total tracks pruned across devices.
 */
export async function sweepTrackRetention(deps: TrackRetentionSweepDeps): Promise<number> {
  const devices = await deps.listDeviceIds()
  const nowMs = deps.now()
  let totalTracks = 0
  for (const deviceId of devices) {
    try {
      const cutoffMs = await deps.resolveCutoffMs(deviceId, nowMs)
      if (cutoffMs === null) continue
      const counts = await deps.pruneTracksBefore(deviceId, cutoffMs)
      totalTracks += counts.tracks
    } catch (err) {
      deps.onError?.(deviceId, err)
    }
  }
  return totalTracks
}
