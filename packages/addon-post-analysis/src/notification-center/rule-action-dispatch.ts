/**
 * Extracted from NotificationCenter (runRuleActions, autoTriggerAlarmPanel, alarmRowsHeard, alarmPushVerdict, alarmWindowScope, intrusionLocationsOf, noteGroupedAlarmPhase, groupedAlarmPhaseOf, deviceIdForRuleActions, evaluateGrouped, groupedLedger).
 * The class method forwards private state through {@link RuleActionDispatchHost}.
 */

import type {
  NcAlarmMatchPhase,
  NcAlarmPushVerdict,
  NcAlarmRowsHeard,
} from './alarm/alarm-push-policy.js'
import { alarmPushDecision, intrusionLocations } from './alarm/alarm-push-policy.js'
import { notificationZones } from './build-entries.js'
import { NcDeviceDirectory } from './device-directory.js'
import { NcDeviceStateCache } from './device-state-cache.js'
import type { NcIntakeControls } from './event-intake.js'
import type { NcGroupedTrackLedger } from './grouped/grouped-delivery.js'
import type { NcGroupedMember } from './grouped/grouped-window-buffer.js'
import { NcJudgedTracks, NcNotifiedTracks } from './grouped/notified-tracks.js'
import { linkedCameraMode, linkedMediaOwners } from './linked-camera-media.js'
import { NcRuleActionRunner } from './rule-actions.js'
import type {
  NcDeviceStateLookup,
  NcEvaluation,
  NcRuleFireRef,
  NcRuleSubject,
  NcSubjectKind,
} from './rule-engine.js'
import { NC_RECOGNITION_CONDITIONS, evaluateRule } from './rule-engine.js'
import { NcRuleStore } from './rule-store.js'
import { NcSceneStateCache } from './scene-state-cache.js'
import { NcSequenceStore } from './sequence-store.js'
import { NcZoneOwnershipCache } from './zone-owner-cache.js'
import type { IScopedLogger, NcRule, NcSystemEventKind } from '@camstack/types'
import { ruleAutoTriggersAlarm } from '@camstack/types'
import type { NcAlarmPanelPort } from './index.js'

/**
 * How often the "matched NO rule" report may fire per device. Long enough that
 * a busy camera prints one line rather than one per event, short enough that a
 * rule which has stopped matching is visible within minutes rather than by
 * comparison with another system fifteen hours later.
 */
/** D706: a match the panel was never asked about (not an alarm rule, no panel, a test). */
export const NO_ALARM_PHASE: NcAlarmMatchPhase = { kind: 'none' }
/** D706: how many (rule, track) alarm phases the grouped close can look up, and for how long. */
export const GROUPED_ALARM_PHASES_MAX = 2_048
export const GROUPED_ALARM_PHASE_TTL_MS = 30 * 60_000
export function groupedAlarmPhaseKey(ruleId: string, trackId: string): string {
  return `${ruleId}|${trackId}`
}
/**
 * ONE match, as provenance an actuated device can carry.
 *
 * `eventId` is frozen only for the kinds that own event-scoped media — the
 * same two `buildEntries` freezes it for. Naming an event id that owns no crop
 * would send the media ladder down a branch that resolves nothing, and the
 * combined alarm notification would then arrive with no picture, which is the
 * one thing it exists to fix.
 */
export function fireRefFor(
  rule: NcRule,
  subject: NcRuleSubject,
  kind: NcSubjectKind,
): NcRuleFireRef {
  const hasEventMedia = kind === 'object-event' || kind === 'package-event'
  // What the rule's OWN notification would have said. Carried only when the
  // match named a detection class — a device or system event has none, and an
  // empty class would put a hole where the subject goes. See NcRuleFireRef.
  const className = subject.classNames[0]
  // A LINKED SET names shelf owners, not a marker track. Freeze the same
  // owners `buildEntries` would have put on the rule's own row — otherwise the
  // combined / pending alarm push (minutes later, after the entry delay) has a
  // media policy and nothing to photograph.
  const linkedOwners =
    subject.trackId === undefined && subject.linkedStills !== undefined
      ? linkedMediaOwners(subject.linkedStills, linkedCameraMode(rule.media))
      : undefined
  const trackId = subject.trackId ?? linkedOwners?.trackId
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    deviceId: subject.deviceId,
    // The SENSOR, when there is one. Provenance the alarm panel reads to know
    // whether this trigger came from a contact it excluded at arm time.
    ...(subject.sourceDeviceId !== undefined ? { sourceDeviceId: subject.sourceDeviceId } : {}),
    recordId: subject.recordId,
    ...(trackId !== undefined ? { trackId } : {}),
    ...(linkedOwners !== undefined && linkedOwners.extraStills.length > 0
      ? { extraStills: linkedOwners.extraStills.map((x) => ({ ...x })) }
      : {}),
    ...(hasEventMedia ? { eventId: subject.recordId } : {}),
    timestamp: subject.timestamp,
    ...(className !== undefined ? { className } : {}),
    ...(subject.label !== undefined ? { label: subject.label } : {}),
    // The rule's OWN zone filter, exactly as its notification would render it
    // — a rule scoped to the gate must not have the drive in its alarm line.
    zones: notificationZones(rule, subject),
    ...(subject.confidence !== undefined ? { confidence: subject.confidence } : {}),
  }
}

export interface RuleActionDispatchHost {
  readonly actionRunner: NcRuleActionRunner | null
  readonly alarmPanel: NcAlarmPanelPort | null
  alarmRowsHeard(): NcAlarmRowsHeard
  autoTriggerAlarmPanel(
    rule: NcRule,
    subject: NcRuleSubject,
    kind: NcSubjectKind,
  ): NcAlarmMatchPhase
  readonly deviceDirectory: NcDeviceDirectory
  deviceStateLookup(read: (deviceId: number) => string | undefined): NcDeviceStateLookup
  readonly deviceStates: NcDeviceStateCache
  readonly groupedAlarmPhases: Map<
    string,
    { readonly phase: NcAlarmMatchPhase; readonly at: number }
  >
  isTriggerOffSubject(subject: NcRuleSubject): boolean
  readonly judgedTracks: NcJudgedTracks
  readonly logger: IScopedLogger
  readonly notifiedTracks: NcNotifiedTracks
  readonly now: () => number
  readonly rules: NcRuleStore
  readonly sceneStates: NcSceneStateCache
  readonly sequences: NcSequenceStore
  readonly zoneOwners: NcZoneOwnershipCache
}

/**
 * Run this rule's onTrigger / onTriggerOff bindings for this match, and —
 * when the rule is gated on `armed_*` — auto-trigger the CamStack
 * alarm-panel (never sirens).
 *
 * Called BEFORE the cooldown gate — see the call site for why. Everything
 * here is fire-and-forget and nothing may throw into the evaluation.
 */
export function runRuleActions(
  host: RuleActionDispatchHost,
  rule: NcRule,
  subject: NcRuleSubject,
  kind: NcSubjectKind,
  controls: NcIntakeControls,
): NcAlarmMatchPhase {
  if (controls.runActions === false) return NO_ALARM_PHASE
  const triggerOff = host.isTriggerOffSubject(subject)
  const phase = triggerOff ? NO_ALARM_PHASE : host.autoTriggerAlarmPanel(rule, subject, kind)
  if (host.actionRunner === null) return phase
  const bindings = triggerOff ? rule.actions?.onTriggerOff : rule.actions?.onTrigger
  if (bindings === undefined || bindings.length === 0) return phase
  void host.actionRunner.runBindings({
    ruleId: rule.id,
    ruleName: rule.name,
    deviceId: subject.deviceId,
    bindings,
    lookup: (id) => host.sequences.get(id),
    // The provenance that makes an alarm this sequence sets off deliver ONE
    // notification instead of two — see {@link NcRuleFireRef}.
    origin: fireRefFor(rule, subject, kind),
  })
  return phase
}
/**
 * A rule gated on `armed_*` fires the CamStack panel on match — no
 * `onTrigger` sequence required. Sirens are never actuated here.
 *
 * Returns where the alarm stood for this match, read BEFORE the press (D706): the rule's
 * own push follows from it (`alarm-push-policy.ts`).
 */
export function autoTriggerAlarmPanel(
  host: RuleActionDispatchHost,
  rule: NcRule,
  subject: NcRuleSubject,
  kind: NcSubjectKind,
): NcAlarmMatchPhase {
  if (!ruleAutoTriggersAlarm(rule)) return NO_ALARM_PHASE
  const panel = host.alarmPanel
  if (panel === null) {
    host.logger.warn('alarm rule matched but no alarm panel is wired — panel not triggered', {
      tags: { deviceId: subject.deviceId },
      meta: { ruleId: rule.id, rule: rule.name },
    })
    return NO_ALARM_PHASE
  }
  const origin = fireRefFor(rule, subject, kind)
  const phase = panel.classifyRuleMatch(origin)
  // SYNCHRONOUS, the source in the call (D735): the press lands before the next match of
  // this evaluation chain is classified, so no two presses can exchange their sources.
  try {
    panel.triggerFromRule(origin)
  } catch (err: unknown) {
    host.logger.warn('alarm panel auto-trigger failed', {
      tags: { deviceId: subject.deviceId },
      meta: {
        ruleId: rule.id,
        rule: rule.name,
        panelId: panel.deviceId,
        error: err instanceof Error ? err.message : String(err),
      },
    })
  }
  return phase
}
/**
 * Which alarm rows an enabled rule delivers (D706) — a suppression needs somebody to hear
 * the alarm instead. Read from the RAM rule mirror, never the store.
 */
export function alarmRowsHeard(host: RuleActionDispatchHost): NcAlarmRowsHeard {
  const rules = host.rules.listEnabled('system-event')
  const hears = (kind: NcSystemEventKind): boolean =>
    rules.some((r) => r.conditions.systemEvent?.kinds.includes(kind) === true)
  return { pending: hears('alarm-pending'), triggered: hears('alarm-triggered') }
}
/**
 * What an alarm rule's OWN push does for one match (D706, `alarm-push-policy.ts`). A
 * suppression the policy had to WAIVE — nobody would hear the alarm row instead — is a
 * WARN on the device: the push goes out, and the configuration gap is named.
 */
export function alarmPushVerdict(
  host: RuleActionDispatchHost,
  rule: NcRule,
  deviceId: number,
  phase: NcAlarmMatchPhase,
): NcAlarmPushVerdict {
  if (phase.kind === 'none') return { kind: 'plain' }
  const decision = alarmPushDecision(phase, host.alarmRowsHeard())
  if (decision.waived !== undefined) {
    host.logger.warn('alarm rule push kept — no enabled rule delivers the alarm notification', {
      tags: { deviceId },
      meta: {
        ruleId: rule.id,
        rule: rule.name,
        phase: phase.kind,
        wouldSuppress: decision.waived,
        missingKind:
          decision.waived === 'alarm-entry-delay-started' ? 'alarm-pending' : 'alarm-triggered',
      },
    })
  }
  return decision.verdict
}
/**
 * D706: the scope of an alarm rule's grouped window, read off the panel's state NOW (the
 * same mirror the rule gate reads). Outside an entry delay or a trigger, D692 keying stands.
 */
export function alarmWindowScope(host: RuleActionDispatchHost, rule: NcRule): 'camera' | 'rule' {
  const panel = host.alarmPanel
  if (panel === null || !ruleAutoTriggersAlarm(rule)) return 'camera'
  const state = panel.currentState()
  return state === 'pending' || state === 'triggered' ? 'rule' : 'camera'
}
/** The words an intrusion title names (D706): location, else name, of each device. */
export function intrusionLocationsOf(
  host: RuleActionDispatchHost,
  deviceIds: readonly number[],
): readonly string[] {
  return intrusionLocations(deviceIds, (id) => {
    const identity = host.deviceDirectory.get(id)
    return {
      ...(identity?.location !== undefined ? { location: identity.location } : {}),
      ...(identity !== undefined ? { name: identity.name } : {}),
    }
  })
}
/**
 * D706: remember where the alarm stood when a GROUPED rule's track matched, so the window's
 * close can apply the same policy the plain path applies at the match. The latest phase of
 * a (rule, track) wins — the panel already keeps a starter its starter. RAM only, bounded.
 */
export function noteGroupedAlarmPhase(
  host: RuleActionDispatchHost,
  rule: NcRule,
  subject: NcRuleSubject,
  phase: NcAlarmMatchPhase,
): void {
  const trackId = subject.trackId
  if (trackId === undefined || !ruleAutoTriggersAlarm(rule)) return
  const now = host.now()
  if (host.groupedAlarmPhases.size >= GROUPED_ALARM_PHASES_MAX) {
    for (const [key, held] of host.groupedAlarmPhases) {
      if (now - held.at > GROUPED_ALARM_PHASE_TTL_MS) host.groupedAlarmPhases.delete(key)
    }
    // Still full: the oldest insertion goes (Map order).
    const oldest = host.groupedAlarmPhases.keys().next()
    if (host.groupedAlarmPhases.size >= GROUPED_ALARM_PHASES_MAX && oldest.done !== true) {
      host.groupedAlarmPhases.delete(oldest.value)
    }
  }
  const key = groupedAlarmPhaseKey(rule.id, trackId)
  host.groupedAlarmPhases.delete(key)
  host.groupedAlarmPhases.set(key, { phase, at: now })
}
/** The phase a grouped member matched under, or `none` when it never pressed the panel. */
export function groupedAlarmPhaseOf(
  host: RuleActionDispatchHost,
  ruleId: string,
  member: NcGroupedMember,
): NcAlarmMatchPhase {
  for (const id of [member.trackId, ...member.absorbedIds]) {
    const held = host.groupedAlarmPhases.get(groupedAlarmPhaseKey(ruleId, id))
    if (held !== undefined && host.now() - held.at <= GROUPED_ALARM_PHASE_TTL_MS) {
      return held.phase
    }
  }
  return NO_ALARM_PHASE
}
/** Device id for activation/deactivation log tags — first scoped device, else 0. */
export function deviceIdForRuleActions(rule: NcRule): number {
  const devices = rule.conditions.devices
  if (devices !== undefined && devices.length > 0) {
    const first = devices[0]
    if (first !== undefined) return first
  }
  return 0
}
/** D692: a grouped rule's evaluation — full, or relaxed (§3.2) — with the centre's lookups. */
export function evaluateGrouped(
  host: RuleActionDispatchHost,
  rule: NcRule,
  subject: NcRuleSubject,
  relax: boolean,
): NcEvaluation {
  return evaluateRule(
    rule,
    subject,
    host.deviceStateLookup((id) => host.deviceStates.get(id)),
    (id) => host.zoneOwners.get(id),
    (sceneId) => host.sceneStates.get(sceneId),
    relax ? { relax: NC_RECOGNITION_CONDITIONS } : undefined,
  )
}
/**
 * D692: the notified and judged track sets, as the grouped windows read them. The close
 * pass fills both; a track close ends its judgement (C10).
 */
export function groupedLedger(host: RuleActionDispatchHost): NcGroupedTrackLedger {
  return {
    notified: (ruleId, trackId) => host.notifiedTracks.has(ruleId, trackId),
    notifiedRulesFor: (trackId) => host.notifiedTracks.rulesFor(trackId),
    judged: (ruleId, trackId) => host.judgedTracks.has(ruleId, trackId),
    // The subject each rule judged the track on — what a late recognition re-evaluates.
    judgedFor: (deviceId, trackId) => host.judgedTracks.forTrack(deviceId, trackId),
    unjudge: (ruleId, trackId) => host.judgedTracks.remove(ruleId, trackId),
    touch: (ruleId, trackId) => {
      host.notifiedTracks.touch(ruleId, trackId)
      host.judgedTracks.touch(ruleId, trackId)
    },
    trackClosed: (deviceId, trackId) => {
      host.judgedTracks.trackClosed(deviceId, trackId)
      host.notifiedTracks.trackClosed(trackId)
    },
  }
}
