import type { FrameResult } from '@camstack/types'

/**
 * MotionSettleGovernor — decides WHEN the root-plane `package-detection` step
 * should run, so it is NOT executed on every frame.
 *
 * A delivered package is STATIONARY: per-frame inference on it is wasted cost.
 * The interesting moments are the EDGES — someone just set a parcel down, or
 * just picked one up — which coincide with motion in the package zone
 * SETTLING (transitioning from moving to still). This governor fires:
 *
 *   - on a **settle edge**: motion NEAR THE PACKAGE ZONE was observed, then has
 *     been absent for `settleMs` (kills flicker between motion frames and the
 *     "bag briefly set down then snatched back" case). The settle edge opens a
 *     **BURST**, and
 *   - on a **low-cadence safety poll** (`pollIntervalMs`, ~30–60s): a
 *     backstop so a delivery whose motion was never observed (a session-gap
 *     camera that only decodes intermittently) is still eventually caught.
 *
 * ## The burst, and why the poll alone was not enough
 *
 * A parcel appears at the END of a motion episode — the courier walks up, puts
 * it down, walks away. That is a settle edge, and it is the moment we know
 * something MIGHT have been left behind. So the settle edge does not fire one
 * inference, it opens a burst: `burstCount` runs `burstIntervalMs` apart.
 *
 * The poll alone made the downstream promotion criterion unreachable in
 * PRACTICE and the notification useless in LATENCY. One observation per 45s
 * (and on a session-dispatch camera the measured gap was ~2 minutes) meant a
 * parcel needed minutes to accumulate enough evidence to be called parked, if
 * it ever did. The burst supplies the whole evidence chain inside ~20s, so a
 * delivery is reported while the courier is still in the street.
 *
 * The poll stays, unchanged in role: it is the SAFETY NET for the parcel whose
 * motion was never observed at all — a camera that just came up, an occlusion,
 * a missed analyzer frame. It is not the primary path any more.
 *
 * The two feed the SAME downstream round counter (`PackageStillnessTracker`),
 * which is what lets one promotion criterion serve both cadences. That is the
 * relation `scripts/check-package-promotion-satisfiable.ts` enforces.
 *
 * Pure logic with an injected clock (every method takes `now`), mirroring
 * `FrameGovernor` / `recomputeGovernor(now)` — no timers, no `Date.now()`
 * inside, fully unit-testable. Per-device state lives in a Map; the caller
 * consults it only while the step is enabled and calls `forget()` on detach.
 *
 * NOTE: today `motionInZone` is the whole-frame analyzer motion signal the
 * runner already tracks (`lastAnalyzerDetected`). Scoping it to the package
 * zone specifically (intersecting motion regions with the `package`-stage
 * zones) is a refinement that lands with the crop-zone frame-prep follow-up,
 * where the package zones first become available at the frame layer. The
 * governor contract does not change when that happens — only the boolean the
 * caller feeds it.
 *
 * See docs/superpowers/specs/2026-07-17-package-zones-design.md
 * (ADDENDUM 2026-07-17 — motion-settle trigger).
 */

/** The step id (`PipelineStepInput.addonId`) the governor gates. */
export const PACKAGE_DETECTION_STEP_ID = 'package-detection'

/** The slice of a dispatched step {@link withPackageLook} reads. */
export interface DispatchedStepRef {
  readonly addonId: string
  readonly enabled?: boolean
}

/**
 * The executor's frame, stamped `packageLooked` when the `package-detection`
 * root was among the steps actually DISPATCHED for it (the governor let it
 * through) and the frame was not shed. Post-analysis reads it as "an empty
 * doormat on this frame is an ABSENCE, not silence" (D687). Never mutates.
 */
export function withPackageLook(
  result: FrameResult,
  dispatched: readonly DispatchedStepRef[],
  filledByRoot = false,
): FrameResult {
  if (result.shed === true) return result
  // D715/D730: when the camera root supplies `package-detection`, it looked at
  // the doormat on every frame it ran — its `package` boxes are the package
  // step's result, so an empty doormat is an absence there too.
  const ran =
    filledByRoot ||
    dispatched.some((s) => s.addonId === PACKAGE_DETECTION_STEP_ID && s.enabled !== false)
  return ran ? { ...result, packageLooked: true } : result
}

export interface MotionSettleGovernorConfig {
  /**
   * Motion must be ABSENT this long (ms) after having been present for a
   * settle edge to fire. Bridges the gaps between discrete motion frames.
   */
  readonly settleMs: number
  /**
   * Safety-poll interval (ms): run at least this often regardless of motion
   * edges, so a stationary package that never triggered observed motion is
   * still detected. Kept in the 30–60s band (packages are stationary).
   *
   * SAFETY NET, not the primary path — see the module docblock.
   */
  readonly pollIntervalMs: number
  /**
   * How many runs a settle edge fires, INCLUDING the one at the edge itself.
   * Must be at least the downstream promotion round count, or the burst alone
   * cannot promote a parcel and the operator waits for the poll.
   */
  readonly burstCount: number
  /**
   * Spacing between the runs of a burst (ms). Must be at least the downstream
   * round gap, or two burst runs count as ONE observation round and the burst
   * buys nothing.
   */
  readonly burstIntervalMs: number
}

/**
 * Burst: 5 runs, 5s apart — 0s, 5s, 10s, 15s, 20s after the settle edge.
 *
 * Sized as a SAFETY NET when the operator raises `packageDropDwellSec` above
 * zero: the burst SPAN (`(burstCount - 1) × burstIntervalMs` = 20s) must
 * clear that dwell, or the delivery falls back to the 45 s poll. Promotion
 * itself counts FRAMES (`packageDropMinFrames`, default 3), so a single
 * settle session that sees the box three times is enough when dwell is 0 —
 * the 15 s dwell plus a 5 s round-gap missed a real parcel on device 101
 * (2026-08-24 13:40). The relation is pinned by
 * `scripts/check-package-promotion-satisfiable.ts`.
 *
 * Cost: 5 extra inferences per motion episode, on cameras with an active
 * package zone only (the caller consults this governor only while the
 * `package-detection` step is in the camera's tree, and the resolver appends
 * that step only for an enabled `package`-stage zone rule).
 */
export const DEFAULT_MOTION_SETTLE_CONFIG: MotionSettleGovernorConfig = {
  settleMs: 3_000,
  pollIntervalMs: 45_000,
  burstCount: 5,
  burstIntervalMs: 5_000,
}

export interface MotionSettleSample {
  readonly deviceId: number
  /**
   * Whether motion is currently observed NEAR the device's package zones.
   *
   * The caller decides what "near" means and says so
   * (`package-zone-proximity.ts`); this class only reads the boolean. A caller
   * that cannot resolve the zone geometry feeds the whole-frame motion signal
   * instead — fail-OPEN, i.e. more bursts rather than none, because a failed
   * geometry read must never be able to silence the feature.
   */
  readonly motionInZone: boolean
  /** Injected clock — the frame/observation timestamp in ms. */
  readonly now: number
}

export type MotionSettleReason = 'settle' | 'burst' | 'poll'

export interface MotionSettleDecision {
  /** Whether the caller should run `package-detection` on this frame. */
  readonly run: boolean
  readonly reason: MotionSettleReason | null
}

interface DeviceSettleState {
  /** Last time motion was observed for this device, or null if never. */
  readonly lastMotionAt: number | null
  /** True once motion has been seen since the last settle fire (a settle is
   *  pending) — makes the settle edge fire exactly once per motion episode. */
  readonly armed: boolean
  /** Last time the step was allowed to run (settle, burst or poll). */
  readonly lastRunAt: number
  /** Burst runs still owed after the settle edge's own run. 0 = no burst. */
  readonly burstRemaining: number
  /** When the next burst run is due. Meaningless while `burstRemaining` is 0. */
  readonly burstNextAt: number
}

// `NEGATIVE_INFINITY` so the very first evaluation is always poll-due — a
// cold-start baseline run the moment the step is enabled on a camera.
const INITIAL_STATE: DeviceSettleState = {
  lastMotionAt: null,
  armed: false,
  lastRunAt: Number.NEGATIVE_INFINITY,
  burstRemaining: 0,
  burstNextAt: 0,
}

const NO_RUN: MotionSettleDecision = { run: false, reason: null }

export class MotionSettleGovernor {
  private readonly config: MotionSettleGovernorConfig
  private readonly state = new Map<number, DeviceSettleState>()

  constructor(config: MotionSettleGovernorConfig = DEFAULT_MOTION_SETTLE_CONFIG) {
    this.config = config
  }

  /**
   * Decide whether `package-detection` runs for this device this frame, and
   * advance the per-device state immutably. Never throws.
   */
  evaluate(sample: MotionSettleSample): MotionSettleDecision {
    const prev = this.state.get(sample.deviceId) ?? INITIAL_STATE

    const lastMotionAt = sample.motionInZone ? sample.now : prev.lastMotionAt
    const armed = sample.motionInZone ? true : prev.armed

    const settleReady =
      armed &&
      !sample.motionInZone &&
      lastMotionAt !== null &&
      sample.now - lastMotionAt >= this.config.settleMs

    const pollReady = sample.now - prev.lastRunAt >= this.config.pollIntervalMs

    if (settleReady) {
      // Consume the episode (disarm), fire the edge run and OPEN the burst.
      // A fresh settle inside an open burst restarts it rather than extending
      // it: the scene moved again, so the evidence collected before that
      // movement describes a scene that no longer exists.
      this.state.set(sample.deviceId, {
        lastMotionAt,
        armed: false,
        lastRunAt: sample.now,
        burstRemaining: Math.max(0, this.config.burstCount - 1),
        burstNextAt: sample.now + this.config.burstIntervalMs,
      })
      return { run: true, reason: 'settle' }
    }

    // The burst outranks the poll: it is the path with the evidence.
    if (prev.burstRemaining > 0 && sample.now >= prev.burstNextAt) {
      this.state.set(sample.deviceId, {
        lastMotionAt,
        armed,
        lastRunAt: sample.now,
        burstRemaining: prev.burstRemaining - 1,
        burstNextAt: sample.now + this.config.burstIntervalMs,
      })
      return { run: true, reason: 'burst' }
    }

    if (pollReady) {
      // Keep `armed` — a subsequent settle in the same episode still fires.
      this.state.set(sample.deviceId, {
        lastMotionAt,
        armed,
        lastRunAt: sample.now,
        burstRemaining: prev.burstRemaining,
        burstNextAt: prev.burstNextAt,
      })
      return { run: true, reason: 'poll' }
    }

    this.state.set(sample.deviceId, {
      lastMotionAt,
      armed,
      lastRunAt: prev.lastRunAt,
      burstRemaining: prev.burstRemaining,
      burstNextAt: prev.burstNextAt,
    })
    return NO_RUN
  }

  /** Drop a device's state (call on detach / step-disable) to avoid a leak. */
  forget(deviceId: number): void {
    this.state.delete(deviceId)
  }

  /** Clear all state (e.g. runner teardown). */
  reset(): void {
    this.state.clear()
  }
}
