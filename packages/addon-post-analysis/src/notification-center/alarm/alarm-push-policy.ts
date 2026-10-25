/**
 * What an alarm rule's OWN push does, given where the alarm stood when the rule matched
 * (D706) — as pure functions.
 *
 * A rule gated on `armed_*` presses the panel on every match (D701). The panel answers by
 * phase, and the rule's own notification follows the operator's policy (2026-10-06):
 *
 * | phase of the match | the rule's own push |
 * | --- | --- |
 * | it STARTS the entry delay | not sent: the entry-delay notification is the one push |
 * | the entry delay is running | not sent (default); sent as an INTRUSION when the mode says so |
 * | the alarm has triggered | sent as an INTRUSION, on the rule's own delay/grouping |
 * | it triggers at once (entry delay 0) | unchanged: the D126 combined row supersedes it |
 * | the sensor is EXCLUDED by the current arm | not sent: the panel's bypass logic speaks for it (D735) |
 * | the operator BYPASSED this (rule, input) until disarm | not sent: the panel counts and logs the drop |
 * | no alarm phase | unchanged |
 *
 * An INTRUSION push is the rule's own row with its title replaced by the locations of the
 * devices that matched ("Intrusion — Ground floor hallway"); its body is the ordinary
 * detection sentence. It is never merged into an alarm row.
 *
 * A suppression needs somebody to hear the alarm instead. When no enabled rule delivers the
 * alarm row that would carry the match (`alarm-pending` for the starter, `alarm-triggered`
 * for a match during the delay), the rule's push is kept and the caller WARNs — a policy that
 * silenced the only notification would be a blackout, not a de-duplication.
 */
import type { AlarmArmMode } from '@camstack/types'

/** Where the alarm stood for one match, as the panel classified it BEFORE pressing it. */
export type NcAlarmMatchPhase =
  /** The panel is not wired, or not armed. */
  | { readonly kind: 'none' }
  /**
   * The match's sensor is EXCLUDED by the current arm (open when it armed): the press is
   * ignored, and so is the rule's own push (D735). A recovery or re-sync of a contact that
   * was open all along matched a rule on 2026-10-07 and pushed "porta porch" four times
   * in 60 ms while the alarm itself rightly did nothing.
   */
  | { readonly kind: 'excluded'; readonly sensorDeviceId: number }
  /**
   * The operator bypassed this (rule, input) pair until disarm: the press is dropped, and so
   * is the rule's own push — a false positive that keeps re-triggering is exactly what the
   * operator asked to stop hearing. The panel counts and logs every drop.
   */
  | { readonly kind: 'bypassed'; readonly ruleId: string; readonly sensorDeviceId: number }
  /** This match starts the entry delay — or is the subject that already started it. */
  | { readonly kind: 'starts-entry-delay'; readonly mode: AlarmArmMode }
  /** The entry delay is 0: the alarm triggers on this match (D126 combines it). */
  | { readonly kind: 'triggers-now'; readonly mode: AlarmArmMode }
  /** Another subject started the entry delay, and it is still running. */
  | {
      readonly kind: 'entry-delay'
      readonly mode: AlarmArmMode
      /** The mode's `notifyDuringEntryDelay` switch, read at the match. */
      readonly notify: boolean
    }
  /** The alarm has triggered and has not re-armed or been disarmed yet. */
  | { readonly kind: 'triggered'; readonly mode: AlarmArmMode }

/** Why a rule's own push was not sent — the `reason` of the line that says so. */
export type NcAlarmPushSuppressReason =
  /** The match started the entry delay; the entry-delay notification speaks for it. */
  | 'alarm-entry-delay-started'
  /** A match during the entry delay of a mode that does not notify then; it is a tile. */
  | 'alarm-entry-delay'
  /** The match's sensor is excluded by the current arm; the panel's bypass logic speaks for it. */
  | 'alarm-sensor-excluded'
  /** The operator bypassed this (rule, input) until disarm; the panel counts and logs the drop. */
  | 'alarm-input-bypassed'

export type NcAlarmPushVerdict =
  | { readonly kind: 'plain' }
  | { readonly kind: 'intrusion' }
  | { readonly kind: 'suppress'; readonly reason: NcAlarmPushSuppressReason }

/** Which alarm rows some enabled rule delivers — the "somebody hears it instead" check. */
export interface NcAlarmRowsHeard {
  readonly pending: boolean
  readonly triggered: boolean
}

/**
 * The verdict, plus the reason a suppression was WAIVED (for the caller's WARN). Pure: the
 * phase is the panel's, the heard flags are the rule mirror's.
 */
export interface NcAlarmPushDecision {
  readonly verdict: NcAlarmPushVerdict
  /** Set when the policy would have suppressed and nobody would hear the alarm row. An
   *  excluded sensor is never waived: no alarm row would carry it — that is the point. */
  readonly waived?: Exclude<
    NcAlarmPushSuppressReason,
    'alarm-sensor-excluded' | 'alarm-input-bypassed'
  >
}

export function alarmPushDecision(
  phase: NcAlarmMatchPhase,
  heard: NcAlarmRowsHeard,
): NcAlarmPushDecision {
  switch (phase.kind) {
    case 'none':
    case 'triggers-now':
      return { verdict: { kind: 'plain' } }
    case 'excluded':
      return { verdict: { kind: 'suppress', reason: 'alarm-sensor-excluded' } }
    case 'bypassed':
      return { verdict: { kind: 'suppress', reason: 'alarm-input-bypassed' } }
    case 'triggered':
      return { verdict: { kind: 'intrusion' } }
    case 'starts-entry-delay':
      return heard.pending
        ? { verdict: { kind: 'suppress', reason: 'alarm-entry-delay-started' } }
        : { verdict: { kind: 'plain' }, waived: 'alarm-entry-delay-started' }
    case 'entry-delay':
      if (phase.notify) return { verdict: { kind: 'intrusion' } }
      return heard.triggered
        ? { verdict: { kind: 'suppress', reason: 'alarm-entry-delay' } }
        : { verdict: { kind: 'intrusion' }, waived: 'alarm-entry-delay' }
  }
}

/**
 * The words a location list is made of, distinct and in first-seen order: the device's
 * LOCATION, else its name, else its id. Never empty for a known id — an intrusion title with a
 * hole in it is worse than a device name.
 */
export function intrusionLocations(
  deviceIds: readonly number[],
  describe: (deviceId: number) => { readonly location?: string | null; readonly name?: string },
): readonly string[] {
  const out: string[] = []
  for (const id of deviceIds) {
    const known = describe(id)
    const location = known.location?.trim() ?? ''
    const name = known.name?.trim() ?? ''
    const word = location.length > 0 ? location : name.length > 0 ? name : String(id)
    if (!out.includes(word)) out.push(word)
  }
  return out
}

/** The device a match's location is read from: the SENSOR when there is one, else the camera. */
export function intrusionDeviceOf(ref: {
  readonly deviceId: number
  readonly sourceDeviceId?: number
}): number {
  return ref.sourceDeviceId ?? ref.deviceId
}
