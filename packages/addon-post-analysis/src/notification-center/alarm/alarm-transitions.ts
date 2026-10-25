/**
 * WHICH publishes are worth telling somebody about — as one pure function.
 *
 * The panel re-publishes once a second while a delay runs, and settles its
 * machine on every read, so "the state changed" is not the same question as
 * "something happened". Every CHANGE is told (D630 — to the panel's own
 * `announceTargets`, whatever the rules say); the countdown ticking is not:
 *
 *  - **`alarm-arming`** — the exit delay STARTED, with the seconds left. The
 *    one notification that arrives while the operator can still cancel.
 *  - **`alarm-armed`** — somebody armed it, or changed mode.
 *  - **`alarm-pending`** — the entry delay STARTED: the seconds left to
 *    disarm, and the rule that started it when one did.
 *  - **`alarm-triggered`** — the siren. When the trigger came from a rule's
 *    `onTrigger` sequence, the rule and the subject that set it off ride along,
 *    and a detection-class source makes the notification COMBINED. `alarm-pending`
 *    carries the same source for media (the entry-delay push is otherwise
 *    text-only while the sensor already owns a snapshot).
 *  - **`alarm-rearmed`** — a bounded siren ended and the panel is armed again.
 *    A kind of its own, not `alarm-armed`: "Away armed" in the middle of a
 *    break-in would read as somebody arming it. The distinction lives in
 *    {@link shouldAnnounceArm}.
 *  - **`alarm-disarmed`** — somebody turned it off; `previous` says whether an
 *    entry countdown or a siren was cancelled with it.
 *
 * Three more ride the same shape without being a state change — the panel
 * REPORTS them through the same hook: `alarm-arm-refused`, `alarm-check-failed`
 * and `alarm-sensor-bypass`.
 *
 * A null `previous` is the FIRST publish and produces nothing. A hub restarting
 * while armed re-publishes `armed_away`, and nobody armed anything — every
 * deploy would otherwise announce one, and `settle()` running on boot would
 * re-announce a siren that finished last night. A hub restarting MID-DELAY
 * re-publishes `arming` / `pending` for the same reason and is silent for the
 * same one.
 */

import type { AlarmArmMode, AlarmState, NcSystemEventKind } from '@camstack/types'
import type { NcRuleFireRef } from '../rule-engine.js'
import { armModeOf, shouldAnnounceArm } from './alarm-mode-coverage.js'
import type { AlarmEntryDelay, AlarmExitDelay } from './alarm-state-machine.js'

/** The alarm members of `NcSystemEventKindSchema`, narrowed. */
export type NcAlarmTransitionKind = Extract<
  NcSystemEventKind,
  | 'alarm-arming'
  | 'alarm-triggered'
  | 'alarm-armed'
  | 'alarm-disarmed'
  | 'alarm-pending'
  | 'alarm-rearmed'
  // Not produced by {@link alarmTransition} — the panel did not transition, it
  // REFUSED to, armed without its check, or ignored / re-admitted one sensor.
  // They ride the same shape because they take the same road out (one intake,
  // one outbox row, one sentence in the reader's language), and a shape of
  // their own would fork the alarm's delivery path in two.
  | 'alarm-arm-refused'
  | 'alarm-check-failed'
  | 'alarm-sensor-bypass'
>

/** One sensor the current arm ignored, or stopped ignoring. */
export interface NcAlarmBypassedSensor {
  readonly deviceId: number
  /** Only when the reporter knows it; the intake falls back to the directory. */
  readonly name?: string
  /**
   * `ignored` — it set the alarm off while excluded, and the trigger was
   * dropped; `lifted` — it closed and opened again, and is watched once more.
   */
  readonly event: 'ignored' | 'lifted'
}

/** A device a refusal named, as the operator was shown it. */
export interface NcAlarmBlockingDevice {
  readonly deviceId: number
  readonly name: string
  readonly state: string
}

/**
 * WHY the panel went off: the rule whose action sequence pressed the button,
 * and the detection that rule matched on.
 *
 * The alarm event knows none of this on its own — a `trigger()` is a `trigger()`
 * whoever called it — so it is handed forward from the action runner and
 * stamped here. Its ABSENCE is meaningful and is the manual/API case: an
 * operator pressing trigger in the UI gets a plain alarm notification, because
 * there is no rule and no picture to combine with.
 */
export type NcAlarmTriggerSource = NcRuleFireRef

/** One publish worth notifying about. */
export interface NcAlarmTransition {
  readonly kind: NcAlarmTransitionKind
  readonly state: AlarmState
  readonly previous: AlarmState
  /** Set on `alarm-armed` (the mode that took effect) and on `alarm-arming`
   *  (the mode the exit delay is running towards). */
  readonly mode?: AlarmArmMode
  readonly at: number
  /**
   * Set on `alarm-arming` (seconds until the mode takes effect) and on
   * `alarm-pending` (seconds until the siren) — rounded UP, floored at zero.
   *
   * Up, because a 30-second delay announced as 29 reads as a hub that is
   * already behind; floored, because `settle()` may report a publish a tick
   * late and "armed in -1 seconds" is a sentence that would reach a phone.
   */
  readonly seconds?: number
  /** Set on `alarm-triggered` and `alarm-pending`, only when a rule caused it. */
  readonly source?: NcAlarmTriggerSource
  /**
   * Set only on `alarm-triggered`, beside a `source`: the OTHER rule matches that
   * pressed the panel while its entry delay ran (D705). The trigger they made was
   * refused — the countdown was already running — so this is the only place their
   * subjects survive; the combined row tiles them with the source as one mosaic.
   * In the order they arrived; never the source again; absent when there were none.
   */
  readonly followers?: readonly NcAlarmTriggerSource[]
  /** Set only on `alarm-arm-refused`: the refusal its Arm anyway is bound to. */
  readonly refusalId?: string
  /** Set only on `alarm-arm-refused`: the devices that refused it, as shown. */
  readonly blocking?: readonly NcAlarmBlockingDevice[]
  /** Set only on `alarm-sensor-bypass`. */
  readonly sensor?: NcAlarmBypassedSensor
  /**
   * Set on `alarm-disarmed` when the panel auto-disarmed after a bounded
   * `disableAfter` window (not a human disarm during the siren).
   */
  readonly autoCleared?: boolean
}

/**
 * How many followers one incident keeps (D705). The mosaic tiles at most
 * `NC_GROUPED_MOSAIC_MAX_TILES` (6) and the sentence counts every member, so this
 * bounds RAM and the frozen row, not the picture: a camera that keeps matching for
 * a whole entry delay must not grow the row without limit.
 */
export const NC_ALARM_INCIDENT_MAX_FOLLOWERS = 15

/**
 * What {@link NcAlarmAttribution.follow} did with the source of a rule press the
 * panel REFUSED because its entry delay was already running (D705). Every outcome
 * is a line at the caller: a match that pressed the panel and is not in the alarm
 * notification must say why.
 *
 *  - `joined` — kept; it rides the alarm notification as a mosaic tile;
 *  - `duplicate` — the same subject (track, else record) is already in the incident;
 *  - `full` — {@link NC_ALARM_INCIDENT_MAX_FOLLOWERS} reached;
 *  - `no-incident` — the countdown belongs to nobody (a manual trigger): there is no
 *    combined row to put a picture on, and a follower must not become the source.
 */
export type NcAlarmFollowOutcome =
  | { readonly kind: 'joined'; readonly source: NcRuleFireRef; readonly followers: number }
  | { readonly kind: 'duplicate'; readonly source: NcRuleFireRef }
  | { readonly kind: 'full'; readonly source: NcRuleFireRef }
  | { readonly kind: 'no-incident'; readonly source: NcRuleFireRef }

/** The subject a fire ref is about: its track, else its record. Exported for D706: the
 *  panel asks whether a match is the subject that started the entry delay. */
export function subjectKeyOf(ref: NcRuleFireRef): string {
  return ref.trackId !== undefined ? `t:${ref.trackId}` : `r:${ref.deviceId}:${ref.recordId}`
}

/**
 * WHO the panel's current countdown belongs to.
 *
 * Small and separate because its whole content is a LIFETIME, and a lifetime
 * is what goes wrong: the trigger and the siren are up to `entryDelaySec`
 * apart, and in between the operator may disarm, re-arm, or press trigger by
 * hand. Each of those must drop the attribution, or tonight's alarm arrives
 * carrying last night's photograph.
 *
 * It holds NO pending press. A rule press carries its source IN the call
 * (`NcAlarmPanelDevice.triggerFromRule`), synchronously, so there is nothing
 * to hand over and nothing to overwrite. The single "next trigger is this
 * rule's" slot this class used to hold was written before an awaited cap call
 * and read when the call landed; two matches 1 ms apart overwrote it, one press
 * landed with no source, skipped the exclusion check and sounded the siren off
 * an excluded contact (2026-10-07 02:32Z, D735).
 */
export class NcAlarmAttribution {
  private claimed: NcRuleFireRef | null = null
  /** The incident's other subjects (D705) — replaced, never mutated. */
  private followed: readonly NcRuleFireRef[] = []

  /**
   * Called by EVERY accepted trigger with the source that pressed it — `null`
   * for a manual or external press, so it clears whatever a rule left behind
   * rather than inheriting it. A new countdown is a new incident: nothing the
   * last one collected rides it.
   */
  claim(source: NcRuleFireRef | null): void {
    this.claimed = source
    this.followed = []
  }

  /**
   * A rule press the panel REFUSED because its entry delay is already running
   * (D705): its source is another subject of the SAME incident.
   *
   * Only an incident a rule started collects followers: the combined row is the
   * source rule's, and promoting a follower to source would change the sentence.
   */
  follow(source: NcRuleFireRef): NcAlarmFollowOutcome {
    const claimed = this.claimed
    if (claimed === null) return { kind: 'no-incident', source }
    const key = subjectKeyOf(source)
    if (subjectKeyOf(claimed) === key || this.followed.some((f) => subjectKeyOf(f) === key)) {
      return { kind: 'duplicate', source }
    }
    if (this.followed.length >= NC_ALARM_INCIDENT_MAX_FOLLOWERS) return { kind: 'full', source }
    this.followed = [...this.followed, source]
    return { kind: 'joined', source, followers: this.followed.length }
  }

  /** The incident's other subjects, in arrival order — see {@link follow}. */
  followers(): readonly NcRuleFireRef[] {
    return this.followed
  }

  /** The attribution the running countdown carries, if any. */
  current(): NcRuleFireRef | null {
    return this.claimed
  }

  /** Drop it: the siren has been announced, or the countdown was cancelled. */
  clear(): void {
    this.claimed = null
    this.followed = []
  }
}

export interface NcAlarmTransitionInput {
  readonly previous: AlarmState | null
  readonly next: AlarmState
  readonly modes: readonly AlarmArmMode[]
  readonly at: number
  readonly source?: NcAlarmTriggerSource
  /** The incident's other subjects — carried onto `alarm-triggered` only (D705). */
  readonly followers?: readonly NcAlarmTriggerSource[]
  /**
   * The exit delay in flight — `exitDelayAt()` in the state machine derives it.
   *
   * Passed in rather than derived from `next`, because `next` is the bare word
   * `arming` and carries neither the mode nor the instant. A caller that cannot
   * supply it — a provider mirroring somebody else's keypad, which reports the
   * word and nothing more — gets no arming transition at all, which is the
   * honest answer: a countdown that can say neither the mode nor the seconds is
   * not a countdown notification.
   */
  readonly arming?: AlarmExitDelay
  /** The entry delay in flight — `pendingAt()` derives it; absent ⇒ no pending transition. */
  readonly pending?: AlarmEntryDelay
  /** True when this disarmed settle came from `disableAfter`, not a human disarm. */
  readonly autoCleared?: boolean
}

/**
 * The transition this publish represents, or null when it represents none.
 *
 * Pure and total: every caller gets the same verdict, and the panel's publish
 * path holds no branching of its own — which is what stops the boot-publish
 * exclusion from being "it works because of the order two things are wired in".
 */
export function alarmTransition(input: NcAlarmTransitionInput): NcAlarmTransition | null {
  const { previous, next, at } = input
  if (previous === null) return null
  if (previous === next) return null
  if (next === 'triggered') {
    return {
      kind: 'alarm-triggered',
      state: next,
      previous,
      at,
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.source !== undefined && input.followers !== undefined && input.followers.length > 0
        ? { followers: input.followers }
        : {}),
    }
  }
  if (next === 'arming') return armingTransition(previous, input)
  if (next === 'pending') return pendingTransition(previous, input)
  if (previous === 'triggered' && next.startsWith('armed_')) {
    // The bounded siren ended and the panel armed ITSELF again.
    //
    // VOLUME, stated rather than suppressed: every siren cycle of a bounded
    // alarm is three notifications — `alarm-pending` (skipped when
    // `entryDelaySec` is 0), `alarm-triggered`, `alarm-rearmed` — and a new
    // cycle can start only after the previous one ends, so a sensor that keeps
    // tripping produces at most one such triple per
    // `entryDelaySec + triggeredDurationSec`. That is the operator's own
    // setting, and each of the three says something new.
    const mode = armModeOf(next, input.modes)
    if (mode === null) return null
    return { kind: 'alarm-rearmed', state: next, previous, mode, at }
  }
  if (shouldAnnounceArm(previous, next)) {
    const mode = armModeOf(next, input.modes)
    // A mode the panel does not offer is not an arm this hub can describe —
    // reporting it would name a mode with no coverage, no label and no rules.
    if (mode === null) return null
    return { kind: 'alarm-armed', state: next, previous, mode, at }
  }
  if (next === 'disarmed') {
    return {
      kind: 'alarm-disarmed',
      state: next,
      previous,
      at,
      ...(input.autoCleared === true ? { autoCleared: true } : {}),
    }
  }
  return null
}

/**
 * The exit delay, as one notification at its START.
 *
 * Reached only from a state CHANGE into `arming`, so the once-a-second
 * re-publish is already excluded by the caller's `previous === next` guard —
 * the countdown is one notification, not thirty. Null when the panel did not
 * say what it is arming into, or named a mode it does not offer: both would
 * produce a message with no title and no number in it.
 */
function armingTransition(
  previous: AlarmState,
  input: NcAlarmTransitionInput,
): NcAlarmTransition | null {
  const arming = input.arming
  if (arming === undefined) return null
  const mode = armModeOf(arming.target, input.modes)
  if (mode === null) return null
  return {
    kind: 'alarm-arming',
    state: 'arming',
    previous,
    mode,
    seconds: Math.max(0, Math.ceil((arming.armedAt - input.at) / 1000)),
    at: input.at,
  }
}

/**
 * The entry delay, as one notification at its START — the mirror of
 * {@link armingTransition}. Null when the panel did not say which mode the
 * countdown belongs to and when it ends: "Intrusion — s to disarm" is not a
 * sentence to send.
 */
function pendingTransition(
  previous: AlarmState,
  input: NcAlarmTransitionInput,
): NcAlarmTransition | null {
  const pending = input.pending
  if (pending === undefined) return null
  const mode = armModeOf(pending.target, input.modes)
  if (mode === null) return null
  return {
    kind: 'alarm-pending',
    state: 'pending',
    previous,
    mode,
    seconds: Math.max(0, Math.ceil((pending.triggerAt - input.at) / 1000)),
    at: input.at,
    ...(input.source !== undefined ? { source: input.source } : {}),
  }
}
