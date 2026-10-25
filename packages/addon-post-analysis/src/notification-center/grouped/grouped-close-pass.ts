/**
 * The FINAL PASS of a grouped window (D692 §3.5, C1, C2) — pure.
 *
 * Every member is judged against the FULL rule (no relaxation) on its latest
 * relaxed-passing subject, the recognition learned since applied (C1). A member is kept
 * when it matches; otherwise it is dropped with ONE named reason, so the close can say
 * where every subject went (D391):
 *
 *  - `already-notified` — this rule already delivered the track (or a track it absorbed)
 *    in an earlier window;
 *  - `recognition-not-final` — a recognition condition failed and the member carries NO
 *    recognition label (still pending, or final without a name); `awaiting` says what it
 *    was still waiting for when it was pending;
 *  - `recognised-out-of-scope` — a recognition condition failed on a member that IS
 *    recognised (someone else, or an excluded identity);
 *  - `failed-condition:<id>` — anything else (a schedule that ended mid-window). Not
 *    expected, and never silent;
 *  - `alarm-entry-delay-started` / `alarm-entry-delay` (D706) — an ALARM rule's member that
 *    matched as the entry delay's starter, or during an entry delay its mode does not notify:
 *    the alarm notification speaks for it;
 *  - `alarm-sensor-excluded` (D735) — an ALARM rule's member whose sensor the current arm
 *    excludes: the panel's bypass logic speaks for it.
 *
 * `fused-into-notified` is the fusion's own drop (`grouped-delivery.ts`); it never reaches
 * this pass.
 */

import type { NcRule } from '@camstack/types'
import {
  NC_RECOGNITION_CONDITIONS,
  type NcEvaluation,
  type NcRecognitionCondition,
  type NcRuleSubject,
} from '../rule-engine.js'
import type { NcAlarmPushSuppressReason, NcAlarmPushVerdict } from '../alarm/alarm-push-policy.js'
import type { NcGroupedMember, NcGroupedWindow } from './grouped-window-buffer.js'

const PLAIN: NcAlarmPushVerdict = { kind: 'plain' }

export type NcGroupedDropReason =
  | 'recognition-not-final'
  | 'recognised-out-of-scope'
  | 'already-notified'
  | 'fused-into-notified'
  // D706: an ALARM rule's member whose push the alarm notification speaks for.
  | NcAlarmPushSuppressReason
  | `failed-condition:${string}`

export interface NcGroupedFate {
  readonly member: NcGroupedMember
  readonly kept: boolean
  readonly reason?: NcGroupedDropReason
  /** Its full-match `matchedOn` (kept members only). */
  readonly matchedOn?: readonly string[]
  /** What a dropped member was still waiting for (C2). */
  readonly awaiting?: string
  /** D706: a kept member of an alarm rule that matched during an intrusion. */
  readonly intrusion?: true
}

export interface NcGroupedClosePassInput {
  readonly rule: NcRule
  readonly window: NcGroupedWindow
  readonly evaluateFull: (subject: NcRuleSubject) => NcEvaluation
  /** This rule already notified the track (survivor or absorbed id). */
  readonly notified: (trackId: string) => boolean
  /** What a non-final member still waits for; `undefined` when it is final. */
  readonly awaitingOf: (member: NcGroupedMember) => string | undefined
  /**
   * D706: what the alarm policy does with a MATCHING member's push — read from the phase the
   * member matched under. Absent = every member plain (a rule that is not an alarm rule).
   */
  readonly alarmVerdictOf?: (member: NcGroupedMember) => NcAlarmPushVerdict
}

function isRecognitionCondition(id: string): id is NcRecognitionCondition {
  return NC_RECOGNITION_CONDITIONS.some((c) => c === id)
}

/** A member dropped for the rule's RECOGNITION scope is judged for it (C10). */
export function isJudgedReason(reason: NcGroupedDropReason | undefined): boolean {
  return reason === 'recognition-not-final' || reason === 'recognised-out-of-scope'
}

export function groupedClosePass(input: NcGroupedClosePassInput): readonly NcGroupedFate[] {
  return input.window.members.map((member): NcGroupedFate => {
    if ([member.trackId, ...member.absorbedIds].some((id) => input.notified(id))) {
      return { member, kept: false, reason: 'already-notified' }
    }
    const verdict = input.evaluateFull(member.subject)
    if (verdict.matched) {
      const alarm = input.alarmVerdictOf?.(member) ?? PLAIN
      if (alarm.kind === 'suppress') return { member, kept: false, reason: alarm.reason }
      return {
        member,
        kept: true,
        ...(verdict.matchedOn !== undefined ? { matchedOn: verdict.matchedOn } : {}),
        ...(alarm.kind === 'intrusion' ? { intrusion: true as const } : {}),
      }
    }
    const failed = verdict.failedCondition ?? 'unknown'
    if (!isRecognitionCondition(failed)) {
      return { member, kept: false, reason: `failed-condition:${failed}` }
    }
    if (member.subject.labelKind === undefined) {
      const awaiting = input.awaitingOf(member)
      return {
        member,
        kept: false,
        reason: 'recognition-not-final',
        ...(awaiting !== undefined ? { awaiting } : {}),
      }
    }
    return { member, kept: false, reason: 'recognised-out-of-scope' }
  })
}
