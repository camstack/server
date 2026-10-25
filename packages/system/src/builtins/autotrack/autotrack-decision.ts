/**
 * `decideAutotrack` — the whole control loop, as one pure function.
 *
 * Error in, action out, clock injected (`nowMs` is a parameter and is never
 * read inside), state immutable (a new state object comes back; the input is
 * never mutated). Same shape as `FrameGovernor` / `MotionSettleGovernor`.
 *
 * ## The one property that makes this safe over droppable telemetry
 *
 * The only command this loop ever issues to move the head is `ptz.move`, which
 * is a SELF-TERMINATING pulse on every driver (reolink 200 ms, amcrest 350,
 * hikvision 500, onvif 1000 — readable as `ptz.getOptions().moveImpulseMs`).
 * `continuousMove` would need a matching `stop`, and its `stop` would travel
 * over an event-driven loop whose input is telemetry and MAY BE DROPPED (D8,
 * D11). A dropped frame would then leave the head panning until someone
 * noticed. With a pulse, a dead event stream means the head stops by itself.
 *
 * That is also why {@link AutotrackDecisionInput.moveImpulseMs} being `null`
 * REFUSES rather than substituting a default: a driver that cannot say how
 * long its pulse lasts has not told us the head stops, and this loop is only
 * safe because it does (D393 — a measurement that failed is `null`).
 */
import type { AutotrackLoopConfig, PtzAxisStep } from './autotrack-config.js'
import type { NormalizedError } from './frame-error.js'

/**
 * What the loop knows about the camera's NATIVE autotrack, from the
 * off-event-path mirror.
 *
 * Native and emulated are two implementations of ONE function and must never
 * be two switches an operator can set to disagree (D62). Until that single
 * switch exists, this slice refuses to move a head whose firmware may also be
 * moving it — and `unknown` refuses too, because not-yet-read must not look
 * like not-enabled (D315, D393).
 */
export type NativeAutotrackState =
  /** The camera has no `ptz-autotrack` binding at all. No conflict possible. */
  | 'absent'
  /** Bound and reported OFF. */
  | 'disabled'
  /** Bound and reported ON — the firmware is driving this head. */
  | 'enabled'
  /** Never successfully read, or the last read failed. */
  | 'unknown'

/** Why the loop did NOT move. Every one of these is logged, per frame, with
 *  the measured error: a loop that decides not to move must not be
 *  indistinguishable from a dead one (D391). */
export type AutotrackHoldReason =
  /** `AUTOTRACK_ARMED` is false, or no target camera is configured. */
  | 'disarmed'
  /** No target has ever been held. */
  | 'no-target'
  /** The held target was absent from this frame, inside its disappear delay. */
  | 'target-absent'
  /** The target is gone and the head has already been sent home. */
  | 'home-already-issued'
  /** The frame did not say how big it is — the error is unknowable (D393). */
  | 'frame-geometry-unknown'
  /** The subject's centre is inside the central dead zone. THE NORMAL CASE. */
  | 'inside-dead-zone'
  /** A correction was running and the subject reached the tighter inner box.
   *  The correction ENDS here, deliberately short of the centre. */
  | 'settled'
  /** The driver does not report `moveImpulseMs`, so nothing proves the pulse
   *  self-terminates. */
  | 'impulse-duration-unknown'
  /** The camera's own autotrack is armed — two sources, one mechanism. */
  | 'native-autotrack-enabled'
  /** The camera's own autotrack state has never been read. */
  | 'native-autotrack-unknown'
  /** The previous pulse is still travelling, or the detector has not yet seen
   *  the framing it produced. */
  | 'pulse-dead-time'
  /** The loop's own commands-per-second ceiling. */
  | 'rate-limited'

export type AutotrackDecision =
  | { readonly action: 'hold'; readonly reason: AutotrackHoldReason }
  | {
      readonly action: 'pulse'
      readonly pan: PtzAxisStep
      readonly tilt: PtzAxisStep
      readonly speed: number
    }
  | { readonly action: 'home'; readonly reason: 'target-gone' }

export interface AutotrackLoopState {
  /** A correction is in progress on this axis: it ends at the tighter inner
   *  box, not at the dead zone it started outside of. */
  readonly correctingX: boolean
  readonly correctingY: boolean
  /** When the last command (pulse or home) was issued. `null` = never. */
  readonly lastCommandAtMs: number | null
  /** Whether the head has already been sent home for the current absence. */
  readonly homeIssued: boolean
}

export const INITIAL_AUTOTRACK_LOOP_STATE: AutotrackLoopState = {
  correctingX: false,
  correctingY: false,
  lastCommandAtMs: null,
  homeIssued: false,
}

/** The held target as this frame saw it. `error` is `null` when the frame's
 *  geometry was unreadable — present-but-unmeasurable, which is NOT absent. */
export interface AutotrackTargetFrame {
  readonly trackId: string
  readonly error: NormalizedError | null
}

export interface AutotrackDecisionInput {
  readonly nowMs: number
  /** Armed AND pointed at a camera. False ⇒ the loop only measures. */
  readonly armed: boolean
  /** The held target if it was OBSERVED on this frame, else `null`. */
  readonly target: AutotrackTargetFrame | null
  /** When the held target was last observed. `null` = nothing held. */
  readonly targetLastSeenAtMs: number | null
  /** `ptz.getOptions().moveImpulseMs`, from the mirror. `null` = unknown. */
  readonly moveImpulseMs: number | null
  readonly nativeAutotrack: NativeAutotrackState
  readonly config: AutotrackLoopConfig
}

export interface AutotrackDecisionResult {
  readonly state: AutotrackLoopState
  readonly decision: AutotrackDecision
}

interface AxisOutcome {
  readonly step: PtzAxisStep
  readonly correcting: boolean
}

/**
 * One axis of the hysteresis.
 *
 * Outside the dead zone a correction STARTS; once started it continues until
 * the subject is inside the tighter settle zone, and then it stops — short of
 * the centre, on purpose. Aiming at the centre with an estimated gain
 * overshoots, and an overshoot reverses the sign on the next frame.
 */
function stepAxis(error: number, correcting: boolean, config: AutotrackLoopConfig): AxisOutcome {
  const deadHalf = config.deadZoneFraction / 2
  const settleHalf = config.settleZoneFraction / 2
  const magnitude = Math.abs(error)
  const nowCorrecting = correcting ? magnitude > settleHalf : magnitude > deadHalf
  if (!nowCorrecting) return { step: 0, correcting: false }
  return { step: error > 0 ? 1 : -1, correcting: true }
}

export function decideAutotrack(
  state: AutotrackLoopState,
  input: AutotrackDecisionInput,
): AutotrackDecisionResult {
  const hold = (
    reason: AutotrackHoldReason,
    next: AutotrackLoopState,
  ): AutotrackDecisionResult => ({
    state: next,
    decision: { action: 'hold', reason },
  })

  if (!input.armed) return hold('disarmed', state)

  if (input.target === null) {
    const idle: AutotrackLoopState = { ...state, correctingX: false, correctingY: false }
    if (input.targetLastSeenAtMs === null) return hold('no-target', idle)
    if (input.nowMs - input.targetLastSeenAtMs < input.config.disappearDelayMs) {
      return hold('target-absent', idle)
    }
    if (state.homeIssued) return hold('home-already-issued', idle)
    return {
      state: { ...idle, homeIssued: true, lastCommandAtMs: input.nowMs },
      decision: { action: 'home', reason: 'target-gone' },
    }
  }

  // The target is here: any home owed for a previous absence is cancelled.
  const present: AutotrackLoopState = { ...state, homeIssued: false }

  if (input.target.error === null) return hold('frame-geometry-unknown', present)

  const x = stepAxis(input.target.error.x, state.correctingX, input.config)
  // Image `y` grows DOWNWARD while `ptz.move`'s `tilt` is positive-UP, so a
  // subject BELOW the centre (error.y > 0) is followed by tilting DOWN.
  const y = stepAxis(input.target.error.y, state.correctingY, input.config)
  const tiltStep: PtzAxisStep = y.step === 0 ? 0 : y.step > 0 ? -1 : 1

  const aimed: AutotrackLoopState = {
    ...present,
    correctingX: x.correcting,
    correctingY: y.correcting,
  }

  if (x.step === 0 && y.step === 0) {
    const wasCorrecting = state.correctingX || state.correctingY
    return hold(wasCorrecting ? 'settled' : 'inside-dead-zone', aimed)
  }

  if (input.nativeAutotrack === 'enabled') return hold('native-autotrack-enabled', aimed)
  if (input.nativeAutotrack === 'unknown') return hold('native-autotrack-unknown', aimed)

  const impulseMs = input.moveImpulseMs
  if (impulseMs === null) return hold('impulse-duration-unknown', aimed)

  const lastCommandAtMs = state.lastCommandAtMs
  if (lastCommandAtMs !== null) {
    const sinceMs = input.nowMs - lastCommandAtMs
    if (sinceMs < impulseMs + input.config.pulseSettleMs) return hold('pulse-dead-time', aimed)
    if (sinceMs < 1000 / input.config.maxCommandsPerSecond) return hold('rate-limited', aimed)
  }

  return {
    state: { ...aimed, lastCommandAtMs: input.nowMs },
    decision: { action: 'pulse', pan: x.step, tilt: tiltStep, speed: input.config.speed },
  }
}
