/**
 * The frame-free half of the package TTL (F4, 2026-09-30).
 *
 * `PackageStillnessTracker.observe` judges expiry only when a frame arrives,
 * so on camera 101 a pick-up whose TTL ran out at 15:28:07 waited for the
 * next analysed frame at 15:28:36. This driver asks the tracker to judge the
 * same TTL on the analytics' existing periodic tick — it adds no timer — for
 * the devices that hold a candidate, and hands each outcome to the SAME bridge
 * a frame's outcome takes. What may be concluded without a frame is the
 * tracker's rule (`sweep`): only a parcel the step looked for and did not find.
 */
import type { PackageDropSettings } from '../../package-settings.js'
import type {
  PackageStillnessOutcome,
  PackageStillnessTracker,
} from './package-stillness-tracker.js'

/** One stillness outcome on its way to `PackageDropDetector` — from a frame
 *  or from the sweep, through the one bridge. */
export interface PackageStillnessBridgeInput {
  readonly deviceId: number
  readonly outcome: PackageStillnessOutcome
  /** When the outcome was judged — the frame's timestamp, or the sweep's now. */
  readonly timestamp: number
  readonly settings: PackageDropSettings
  readonly lastActivityAt?: number
  /** Which path concluded it — on the departure line, so a sweep-concluded
   *  pick-up is distinguishable from a frame-concluded one. */
  readonly via: 'frame' | 'sweep'
}

export interface PackageStillnessSweepDeps {
  readonly tracker: PackageStillnessTracker
  /** Wall clock — frame timestamps are capture instants on the same clock. */
  readonly now: number
  /** The device's `packageDropActivityWindowSec * 1000`. */
  readonly activityWindowMsFor: (deviceId: number) => number
  readonly lastActivityAtFor: (deviceId: number) => number | undefined
  /** Called only for an outcome that concluded something. */
  readonly onOutcome: (deviceId: number, outcome: PackageStillnessOutcome, at: number) => void
  /** A device whose sweep threw — reported, and the next device still runs. */
  readonly onDeviceError: (deviceId: number, err: unknown) => void
}

export function sweepPackageStillness(deps: PackageStillnessSweepDeps): void {
  for (const deviceId of deps.tracker.devicesWithCandidates()) {
    try {
      sweepOne(deps, deviceId)
    } catch (err) {
      deps.onDeviceError(deviceId, err)
    }
  }
}

function sweepOne(deps: PackageStillnessSweepDeps, deviceId: number): void {
  const lastActivityAt = deps.lastActivityAtFor(deviceId)
  const outcome = deps.tracker.sweep({
    deviceId,
    timestamp: deps.now,
    activityWindowMs: deps.activityWindowMsFor(deviceId),
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
  })
  if (
    outcome.departed.length > 0 ||
    outcome.departedWithoutActivity.length > 0 ||
    outcome.expired.length > 0
  ) {
    deps.onOutcome(deviceId, outcome, deps.now)
  }
}
