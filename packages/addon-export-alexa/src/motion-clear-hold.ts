/**
 * Falling-edge hold for the `Alexa.MotionSensor` ChangeReport stream.
 *
 * The gateway used to dedupe motion on state TRANSITIONS alone: a repeated
 * `detected:true` was dropped, but every `true → false → true` cycle went out
 * as two ChangeReports. That is correct for a well-behaved source and ruinous
 * for a chatty one. Measured live on 2026-08-07, camera 104, over 692 s:
 *
 * ```
 * 218 motion DETECTED posted      status=202
 * 219 motion NOT_DETECTED posted  status=202
 * 223 smartvision person posted   status=202
 * ```
 *
 * — a median 1.76 s between consecutive DETECTED posts, ~660 gateway POSTs in
 * eleven minutes for ONE camera. The source is upstream and outside this
 * addon: `motion.getStatus` on 104 carries `autoClearAfterMs: 3000` against a
 * provider that re-fires every ~1.8 s, so the provider genuinely alternates and
 * the transition dedupe was faithfully relaying it. Nothing here reaches into
 * that; this bounds what the EXPORT puts on Amazon's Event Gateway, which is
 * this addon's own business — a rate-limited skill is a skill whose events stop
 * arriving.
 *
 * The shape is the one `addon-export-hap`'s motion builder already uses
 * (`RESET_DEBOUNCE_MS`): the rising edge is instant, because a late motion
 * alert is a useless motion alert; the falling edge waits for the source to go
 * quiet. A camera that flaps therefore reads as ONE continuous motion, which is
 * also what a human watching it would say.
 *
 * This object is the SINGLE authority on what Alexa currently believes about a
 * given endpoint's `detectionState` — it replaces the old `lastMotionState`
 * map rather than sitting beside it. Two dedupe knobs that can disagree are
 * worse than one.
 */

/** What Alexa has been told, and whether a clear is pending. */
type HoldState = 'idle' | 'detected' | 'holding'

type TimerHandle = ReturnType<typeof setTimeout>

export interface MotionClearHoldOptions {
  /**
   * How long the source must stay clear before `NOT_DETECTED` is released.
   * A DETECTED arriving inside the window cancels the pending clear.
   */
  readonly holdMs: number
  /**
   * Least time between the DETECTED report and the NOT_DETECTED that follows
   * it. Defaults to {@link MIN_DETECTED_BEFORE_CLEAR_MS}.
   */
  readonly minDetectedMs?: number
  /** Injected for tests. Defaults to the globals. */
  readonly setTimer?: (fn: () => void, ms: number) => TimerHandle
  readonly clearTimer?: (handle: TimerHandle) => void
}

interface Entry {
  readonly state: HoldState
  readonly timer: TimerHandle | null
  /** When Alexa was told DETECTED (ms epoch); null when unknown. */
  readonly detectedAt: number | null
}

/**
 * Default hold. Matches `RESET_DEBOUNCE_MS` in
 * `addon-export-hap/src/mappers/builders/motion-sensor.ts` — the same problem
 * (a source that never reliably clears, or clears too eagerly) already has an
 * answer in this repo and a second number would only invite them to drift.
 */
export const DEFAULT_MOTION_CLEAR_HOLD_MS = 5_000

/**
 * Amazon's floor (alexa-motionsensor): "When a motion sensor changes to
 * `DETECTED`, and then changes to `NOT_DETECTED`, you must wait at least 30
 * seconds before sending the second change report." Independent of the quiet
 * hold above: the clear goes out at whichever of the two is later.
 */
export const MIN_DETECTED_BEFORE_CLEAR_MS = 30_000

export class MotionClearHold {
  private readonly entries = new Map<string, Entry>()
  private readonly holdMs: number
  private readonly minDetectedMs: number
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle
  private readonly clearTimer: (handle: TimerHandle) => void

  constructor(options: MotionClearHoldOptions) {
    this.holdMs = options.holdMs
    this.minDetectedMs = options.minDetectedMs ?? MIN_DETECTED_BEFORE_CLEAR_MS
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
  }

  /**
   * The source reports motion.
   *
   * @returns `true` when Alexa must be told (it currently believes
   *   NOT_DETECTED). `false` when Alexa already believes DETECTED — including
   *   the case where a clear was pending, which this call cancels.
   */
  onDetected(key: string): boolean {
    const entry = this.entries.get(key)
    if (entry?.state === 'detected') return false
    if (entry?.state === 'holding') {
      // Alexa still believes DETECTED. Cancel the pending clear and say
      // nothing — this is the flap the hold exists to absorb.
      if (entry.timer !== null) this.clearTimer(entry.timer)
      this.entries.set(key, { state: 'detected', timer: null, detectedAt: entry.detectedAt })
      return false
    }
    this.entries.set(key, { state: 'detected', timer: null, detectedAt: Date.now() })
    return true
  }

  /**
   * The source reports no motion. Arms the hold; `release` runs once the
   * source has stayed clear for `holdMs`. A no-op when we KNOW Alexa already
   * believes NOT_DETECTED, or when a clear is already pending.
   *
   * An UNKNOWN key arms the hold rather than returning early, and that is the
   * whole reason this branch is spelled out. This map is in-memory: after an
   * addon restart it is empty, while Alexa's copy of `detectionState` is
   * whatever we last told it. If the addon respawned during a motion — which a
   * `camstack deploy` does routinely — treating "unknown" as "already clear"
   * leaves the Alexa app showing motion until that camera happens to trigger
   * again, which on a quiet camera is hours. The cost of the other choice is
   * at most one redundant NOT_DETECTED per camera per restart.
   */
  onCleared(key: string, release: () => void): void {
    const entry = this.entries.get(key)
    if (entry !== undefined && entry.state !== 'detected') return
    // An unknown DETECTED time (restart) waits the whole minimum: the report
    // may have gone out moments before the respawn.
    const detectedAt = entry?.detectedAt ?? null
    const sinceDetected = detectedAt === null ? 0 : Date.now() - detectedAt
    const delay = Math.max(this.holdMs, this.minDetectedMs - sinceDetected)
    const timer = this.setTimer(() => {
      this.entries.set(key, { state: 'idle', timer: null, detectedAt: null })
      release()
    }, delay)
    this.entries.set(key, { state: 'holding', timer, detectedAt })
  }

  /** What Alexa currently believes for this key — for logs and assertions. */
  believedDetected(key: string): boolean {
    const state = this.entries.get(key)?.state
    return state === 'detected' || state === 'holding'
  }

  /** Cancel every pending clear and forget all state. */
  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer !== null) this.clearTimer(entry.timer)
    }
    this.entries.clear()
  }
}
