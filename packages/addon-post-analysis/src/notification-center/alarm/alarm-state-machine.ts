/**
 * The alarm's state machine, as pure functions.
 *
 * `alarm-panel` already declares the whole lifecycle — `disarmed`,
 * `armed_*`, `arming`, `pending`, `disarming`, `triggered`. Until now the only
 * provider was Home Assistant, mirroring someone else's panel, so the
 * TRANSITIONAL states were passed through and never produced. This produces
 * them, which is the entire difference between a panel and a boolean:
 *
 *  - **`arming`** is the exit delay. Without it you cannot arm and then leave.
 *  - **`pending`** is the entry delay. Without it, coming home sets the alarm
 *    off before you can reach the keypad.
 *  - **`triggered`** now has a DURATION. Without one, a single event leaves the
 *    panel triggered — and therefore not re-armable — until a human clears it,
 *    so the rest of the night is unprotected.
 *
 * All three are expressed as an INSTANT the state changes at, never as a timer that
 * has to fire. `stateAt(now)` is a comparison, so a missed tick delays a
 * notification instead of leaving the alarm wedged in `arming` forever — the
 * same reason a snooze expires by comparison rather than by a sweeper.
 */

import {
  type AlarmArmMode,
  type AlarmState,
  NC_ALARM_DEFAULT_TRIGGERED_DURATION_SEC,
} from '@camstack/types'

/**
 * What the panel does when a bounded `triggered` window ends.
 * - `rearmAfter` — return to the armed mode (historical default when duration > 0)
 * - `disableAfter` — auto-disarm
 * - `doNothing` — stay triggered until a human disarms (historical duration 0)
 */
export type AlarmPostTriggeredAction = 'rearmAfter' | 'disableAfter' | 'doNothing'

/** How long the operator has to leave after arming, and to disarm on entry. */
export interface AlarmDelays {
  readonly exitDelaySec: number
  readonly entryDelaySec: number
  /**
   * How long `triggered` lasts before {@link postTriggeredAction} runs.
   * Ignored when the action is `doNothing`.
   */
  readonly triggeredDurationSec: number
  readonly postTriggeredAction: AlarmPostTriggeredAction
}

/**
 * Everything the panel is, at rest. Deliberately a value: it is persisted as
 * the cap's `runtimeState`, and every transition returns a NEW one.
 */
export interface AlarmMachine {
  /** What the panel settles into — never a transitional state. */
  readonly target: Extract<AlarmState, 'disarmed' | `armed_${string}`>
  /** Set while arming: the instant `arming` becomes `target`. */
  readonly armedAt?: number
  /** Set while pending: the instant `pending` becomes `triggered`. */
  readonly triggerAt?: number
  /**
   * Set when a fire is scheduled or has happened, and only when the operator
   * asked for a bounded post-triggered action: the instant `triggered` ends.
   *
   * An INSTANT, like the other two, and for the same reason — the alarm must
   * not need a surviving timer to stop. A hub restarted mid-siren comes back
   * already settled rather than sounding forever.
   */
  readonly clearAt?: number
  /**
   * When `clearAt` fires: settle to `disarmed` instead of re-arming into
   * `target`. Absent / false = re-arm (historical behaviour).
   */
  readonly clearToDisarmed?: boolean
  /** True once the alarm has actually gone off. */
  readonly fired: boolean
  readonly changedAt: number
}

/**
 * The GLOBAL defaults an operator can change per panel — what a mode inherits
 * when it overrides nothing. A mode can override each of the three since D697
 * (`resolveModeDelays`): `home` has no exit delay on purpose — nobody is
 * leaving — and says so with its own entry, not by this shared value.
 *
 * Default post-triggered action is `rearmAfter` 30 s (D706) — every mode inherits
 * that unless the operator overrides. Older blobs that still store the stock
 * `0` + absent/`doNothing` seed are migrated once at panel boot (D701).
 */
export const DEFAULT_DELAYS: AlarmDelays = {
  exitDelaySec: 30,
  entryDelaySec: 20,
  // D706: 30 s (was 10 s under D701). Only the SEED — a persisted value is never rewritten.
  triggeredDurationSec: NC_ALARM_DEFAULT_TRIGGERED_DURATION_SEC,
  postTriggeredAction: 'rearmAfter',
}

export const DISARMED: AlarmMachine = { target: 'disarmed', fired: false, changedAt: 0 }

function armedState(mode: AlarmArmMode): AlarmMachine['target'] {
  return `armed_${mode}`
}

/**
 * The state to report at `now`.
 *
 * A comparison, not a job: nothing has to run for the exit delay to end. A
 * caller that stops ticking stops NOTIFYING about the change, but the panel's
 * answer is still correct the moment anyone asks.
 */
export function stateAt(m: AlarmMachine, now: number): AlarmState {
  // FIRST, ahead of `fired`: the siren's own duration outranks the fact that
  // it went off. Reading `fired` first would keep answering `triggered`
  // forever, which is the bug this ordering exists to prevent.
  if (m.clearAt !== undefined && now >= m.clearAt) {
    return m.clearToDisarmed === true ? 'disarmed' : m.target
  }
  if (m.fired) return 'triggered'
  if (m.triggerAt !== undefined) return now >= m.triggerAt ? 'triggered' : 'pending'
  if (m.armedAt !== undefined) return now >= m.armedAt ? m.target : 'arming'
  return m.target
}

/**
 * The exit delay in flight: what the panel is arming INTO, and when.
 *
 * `arming` is a bare word — it names neither the mode nor the instant — so the
 * notification that says "Away in 30s" cannot be built from the state alone.
 * This is the pair it is built from, and it exists as a function of the machine
 * rather than as a field on the transition so that "is a delay still running"
 * is answered by the same instants `stateAt` compares, never by a second copy
 * that can disagree with them.
 */
export interface AlarmExitDelay {
  /** The `armed_<mode>` state the delay ends in. */
  readonly target: AlarmState
  /** Ms epoch at which `target` takes effect. */
  readonly armedAt: number
}

/**
 * The exit delay running at `now`, or `undefined` when none is.
 *
 * Gated on `stateAt`, not on `armedAt` alone: the instant survives on the
 * machine after the delay is over (until a settle drops it) and after a trigger
 * has opened a DIFFERENT countdown, and either would announce a countdown for a
 * panel that is already armed or already about to go off.
 */
export function exitDelayAt(m: AlarmMachine, now: number): AlarmExitDelay | undefined {
  if (m.armedAt === undefined) return undefined
  if (stateAt(m, now) !== 'arming') return undefined
  return { target: m.target, armedAt: m.armedAt }
}

/**
 * The entry delay in flight: the mode it belongs to, and when the siren
 * sounds. The mirror of {@link AlarmExitDelay} — `pending` is a bare word too.
 */
export interface AlarmEntryDelay {
  /** The `armed_<mode>` state the countdown belongs to. */
  readonly target: AlarmState
  /** Ms epoch at which `pending` becomes `triggered`. */
  readonly triggerAt: number
}

/**
 * The entry delay running at `now`, or `undefined` when none is. Gated on
 * `stateAt`, like {@link exitDelayAt}: `triggerAt` survives on the machine
 * after the siren sounds, until a settle drops it.
 */
export function pendingAt(m: AlarmMachine, now: number): AlarmEntryDelay | undefined {
  if (m.triggerAt === undefined) return undefined
  if (stateAt(m, now) !== 'pending') return undefined
  return { target: m.target, triggerAt: m.triggerAt }
}

/** Whether the panel is armed enough for a trigger to matter. */
export function isArmed(m: AlarmMachine, now: number): boolean {
  const s = stateAt(m, now)
  return s.startsWith('armed_') || s === 'pending' || s === 'triggered'
}

/**
 * Arm into `mode`. An exit delay of 0 arms immediately — some modes (`home`)
 * legitimately have none, because nobody is leaving.
 */
export function arm(mode: AlarmArmMode, delays: AlarmDelays, now: number): AlarmMachine {
  const target = armedState(mode)
  if (delays.exitDelaySec <= 0) return { target, fired: false, changedAt: now }
  return { target, armedAt: now + delays.exitDelaySec * 1000, fired: false, changedAt: now }
}

/**
 * Disarm, from ANY state — including mid-arming and mid-pending.
 *
 * Cancelling a pending entry is the single most-used transition in a real
 * alarm (walking in and typing the code), and it must CANCEL rather than
 * queue: a disarm that let the pending timer still fire would set the alarm off
 * behind the operator.
 */
export function disarm(now: number): AlarmMachine {
  return { ...DISARMED, changedAt: now }
}

/**
 * Something matched while armed.
 *
 * Starts the entry delay, or fires at once when there is none. A trigger while
 * DISARMED is ignored — the panel is the gate, and a rule that fires while
 * disarmed is a notification, not a break-in.
 *
 * A second trigger during `pending` does NOT restart the countdown: an
 * intruder walking past two sensors would otherwise postpone the alarm.
 */
export function trigger(m: AlarmMachine, delays: AlarmDelays, now: number): AlarmMachine {
  const state = stateAt(m, now)
  // Already going off, or already counting down to it.
  if (state === 'triggered' || state === 'pending') return m
  if (!isArmed(m, now)) return m
  // Settle FIRST so a siren that has already auto-cleared does not carry its
  // spent `clearAt` / `fired` into the new countdown — that stale pair is what
  // would make the SECOND intrusion of the night read as still-triggered.
  const base = settle(m, now)
  const firesAt = now + Math.max(0, delays.entryDelaySec) * 1000
  return {
    ...base,
    triggerAt: firesAt,
    ...autoClear(delays, firesAt),
    fired: false,
    changedAt: now,
  }
}

/**
 * `clearAt` (+ optional disarm) when the operator asked for a bounded
 * post-triggered action — see {@link AlarmDelays}.
 */
function autoClear(
  delays: AlarmDelays,
  firesAt: number,
): { clearAt?: number; clearToDisarmed?: boolean } {
  if (delays.postTriggeredAction === 'doNothing') return {}
  const afterSec = Math.max(0, delays.triggeredDurationSec)
  // Zero seconds with rearm/disable settles immediately at fire — rare but
  // coherent (siren of zero length).
  const clearAt = firesAt + afterSec * 1000
  if (delays.postTriggeredAction === 'disableAfter') {
    return { clearAt, clearToDisarmed: true }
  }
  return { clearAt }
}

/**
 * Settle the machine so a stored value never depends on when it is read.
 *
 * `stateAt` already answers correctly from an unsettled value; this is what a
 * caller persists after a tick, so `fired` becomes true in the record rather
 * than only in the reading of it.
 */
export function settle(m: AlarmMachine, now: number): AlarmMachine {
  if (m.clearAt !== undefined && now >= m.clearAt) {
    // `changedAt` is when the siren stopped, not when anybody looked.
    if (m.clearToDisarmed === true) {
      return { ...DISARMED, changedAt: m.clearAt }
    }
    // Back to the mode it was armed in, and ARMED — every trace of the fire is
    // dropped so the next trigger is a fresh one.
    return { target: m.target, fired: false, changedAt: m.clearAt }
  }
  if (m.triggerAt !== undefined && now >= m.triggerAt) {
    return {
      target: m.target,
      fired: true,
      changedAt: m.triggerAt,
      // Carried, not dropped: this is the instant the siren stops, and losing
      // it here would leave a bounded alarm sounding until a human intervened.
      ...(m.clearAt !== undefined ? { clearAt: m.clearAt } : {}),
      ...(m.clearToDisarmed === true ? { clearToDisarmed: true } : {}),
    }
  }
  if (m.armedAt !== undefined && now >= m.armedAt) {
    return { target: m.target, fired: m.fired, changedAt: m.armedAt }
  }
  return m
}
