/**
 * "Motion is flowing and NOTHING is being inferred" — the failure that has cost
 * this project two incidents, made visible per camera.
 *
 * ## Why this signal and not "zero detections"
 *
 * A camera with motion and zero DETECTIONS is ordinary: leaves move, light
 * changes, nothing walks past. Alerting on that would flood.
 *
 * The pathological case is narrower and unmistakable: motion frames keep
 * arriving while the inference path processes NONE of them. On 2026-07-30
 * device 101 sat like that for 65 minutes — motion every ~5 s throughout,
 * `frames=0` with `dropped≈150` per 10 s interval — and the only reason it
 * presented as "sees movement, detects nothing" rather than as a dead camera
 * is that `drainMotionQueues()` runs BEFORE the inference gate. Nothing
 * reported it; it was found by hand-reading an archive after the operator
 * noticed a missing notification.
 *
 * ## Shape
 *
 * Pure and dependency-free: it is fed one summary per report interval and
 * decides whether to speak. It warns once when the condition has held for
 * `minIntervals` consecutive reports, then stays quiet until it clears, so a
 * long outage produces one line plus a recovery line rather than one every
 * ten seconds.
 */

/** What one report interval saw for one camera. */
export interface IntervalSummary {
  /** Motion frames analysed in the interval. */
  readonly motionFrames: number
  /** Inference frames PROCESSED in the interval (not queued, not dropped). */
  readonly inferenceFrames: number
}

export type StallVerdict =
  | { readonly kind: 'quiet' }
  | { readonly kind: 'stalled'; readonly intervals: number }
  | { readonly kind: 'recovered'; readonly intervals: number }

/**
 * Consecutive intervals the condition must hold before speaking. At the
 * sampler's 10 s cadence, 3 ≈ 30 s — long enough that a single slow interval
 * (a model reload, a burst) says nothing, short enough that a real stall is
 * reported in well under a minute rather than after 65 of them.
 */
export const DEFAULT_MIN_INTERVALS = 3

export class MotionWithoutInferenceDetector {
  private readonly streak = new Map<number, number>()
  private readonly reported = new Set<number>()
  private readonly minIntervals: number

  constructor(minIntervals: number = DEFAULT_MIN_INTERVALS) {
    this.minIntervals = Math.max(1, minIntervals)
  }

  /**
   * Feed one interval for one camera. Returns what, if anything, to say.
   *
   * A camera with NO motion is not evidence either way — it is simply quiet,
   * and its streak is left untouched rather than reset, so an outage that
   * spans a lull is still reported as one continuous stall.
   */
  observe(deviceId: number, summary: IntervalSummary): StallVerdict {
    if (summary.inferenceFrames > 0) {
      const wasReported = this.reported.delete(deviceId)
      const intervals = this.streak.get(deviceId) ?? 0
      this.streak.delete(deviceId)
      return wasReported ? { kind: 'recovered', intervals } : { kind: 'quiet' }
    }
    if (summary.motionFrames <= 0) return { kind: 'quiet' }

    const next = (this.streak.get(deviceId) ?? 0) + 1
    this.streak.set(deviceId, next)
    if (next < this.minIntervals) return { kind: 'quiet' }
    if (this.reported.has(deviceId)) return { kind: 'quiet' }
    this.reported.add(deviceId)
    return { kind: 'stalled', intervals: next }
  }

  /** Drop a camera's state — it was detached, so its streak means nothing. */
  forget(deviceId: number): void {
    this.streak.delete(deviceId)
    this.reported.delete(deviceId)
  }

  /** Cameras currently in a reported stall — the board's "motion, no inference". */
  stalledDevices(): readonly number[] {
    return [...this.reported]
  }
}
