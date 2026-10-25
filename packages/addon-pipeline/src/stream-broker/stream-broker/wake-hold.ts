/**
 * The HOLD a camera's own signal buys, and what it may not buy.
 *
 * A stream a consumer merely watches is not a reason to wake a battery camera —
 * a continuous-pull client holds a session open for ever, and treating that as
 * demand keeps the camera awake for ever, which is the whole point of the
 * battery (D173). So a sentry consumer is FED without being INTENT, and the
 * only thing that dials is a signal the camera reported about itself.
 *
 * This module is the timing half of that, and it is pure so the arithmetic can
 * be argued with. Three rules:
 *
 *  - **A hold EXTENDS, it never stacks.** Continuous motion keeps a camera up
 *    and it sleeps `holdMs` after the LAST signal, not after the sum of them.
 *    A counter or a queue would turn a busy afternoon into an hour of wake.
 *  - **A run is bounded ABSOLUTELY, from its first signal.** A stuck PIR
 *    reporting every second would otherwise extend the hold indefinitely and
 *    drain the battery — the one failure this whole design exists to prevent.
 *    The same re-arm-under-a-ceiling shape D371 gives `recording-signal`.
 *  - **A deadline, not a chain of timers.** The state is one number; the timer
 *    only decides when to LOOK at it. A chain would drift and would have to be
 *    cancelled correctly on every path.
 */

/** How long a camera stays awake after the LAST signal. The operator's, per
 *  camera; this is the default the broker ships. */
export const DEFAULT_WAKE_HOLD_MS = 15_000

/**
 * Ceiling on ONE run, measured from its first signal.
 *
 * Five minutes. Long enough that a genuine sustained event — a person moving
 * around a garden — is covered end to end; short enough that a sensor stuck
 * ON costs one five-minute wake rather than a night.
 */
export const WAKE_HOLD_MAX_RUN_MS = 5 * 60_000

/**
 * How long a camera is left alone after a run hit the ceiling.
 *
 * Without this the ceiling is cosmetic, and the test that found it says why: a
 * run ends exactly AT the ceiling, so the very next signal from a sensor that
 * never stops re-arms a fresh five minutes. Five minutes awake, an instant
 * asleep, five minutes awake — all night, which is the precise failure the
 * ceiling was written to prevent.
 *
 * So a capped run buys silence. Ten minutes: long enough that a stuck sensor
 * costs a third of its time rather than all of it, short enough that a genuine
 * long event — someone working in the garden — resumes within a few minutes
 * instead of being locked out for an hour.
 *
 * Signals during the quarantine are REFUSED and counted, not queued: a queue
 * would fire them all the moment it lifts, which is the same drain arriving
 * late.
 */
export const WAKE_QUARANTINE_AFTER_CAP_MS = 10 * 60_000

export interface WakeHold {
  /** When the current run's FIRST signal arrived. `0` ⇒ no run. */
  readonly runStartedAt: number
  /** When the camera may go back to sleep. `0` ⇒ no run. */
  readonly until: number
  /** How many signals this run has absorbed — for the log line. */
  readonly signals: number
  /**
   * When a new run may arm, after this one hit the ceiling. `0` ⇒ no
   * quarantine. See {@link WAKE_QUARANTINE_AFTER_CAP_MS}.
   */
  readonly quarantinedUntil: number
}

export const NO_HOLD: WakeHold = {
  runStartedAt: 0,
  until: 0,
  signals: 0,
  quarantinedUntil: 0,
}

export interface WakeHoldInput {
  readonly current: WakeHold
  readonly now: number
  readonly holdMs: number
}

export interface WakeHoldResult {
  readonly hold: WakeHold
  /** What happened, for the line the operator reads. */
  readonly outcome: 'armed' | 'extended' | 'capped' | 'quarantined'
}

/**
 * Absorb one signal.
 *
 * A signal arriving with the run already at its ceiling does NOT extend it —
 * and does not start a new one either, because a new run measured from now
 * would be the same unbounded extension wearing a different name. It is
 * reported as `capped` so the operator can see a sensor that will not stop.
 */
export function absorbSignal(input: WakeHoldInput): WakeHoldResult {
  const { current, now, holdMs } = input
  const running = current.until > now && current.runStartedAt > 0
  if (!running) {
    // A run that hit the ceiling buys silence. Counted so the line can say how
    // many a stuck sensor is producing, and refused rather than queued — a
    // queue fires them all when it lifts, which is the same drain arriving
    // late.
    if (current.quarantinedUntil > now) {
      return { hold: { ...current, signals: current.signals + 1 }, outcome: 'quarantined' }
    }
    return {
      hold: { runStartedAt: now, until: now + holdMs, signals: 1, quarantinedUntil: 0 },
      outcome: 'armed',
    }
  }
  const runMs = now - current.runStartedAt
  if (runMs >= WAKE_HOLD_MAX_RUN_MS) {
    return {
      hold: {
        ...current,
        signals: current.signals + 1,
        quarantinedUntil: now + WAKE_QUARANTINE_AFTER_CAP_MS,
      },
      outcome: 'capped',
    }
  }
  // Never past the ceiling, even by one extension. Reaching it arms the
  // quarantine, so the run cannot simply restart the instant it lapses.
  const ceiling = current.runStartedAt + WAKE_HOLD_MAX_RUN_MS
  const until = Math.min(now + holdMs, ceiling)
  return {
    hold: {
      ...current,
      until,
      signals: current.signals + 1,
      ...(until === ceiling ? { quarantinedUntil: ceiling + WAKE_QUARANTINE_AFTER_CAP_MS } : {}),
    },
    outcome: 'extended',
  }
}

/** Whether the hold still keeps the camera awake at `now`. */
export function holdIsLive(hold: WakeHold, now: number): boolean {
  return hold.until > now
}
