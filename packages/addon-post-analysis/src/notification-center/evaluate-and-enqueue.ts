/**
 * Extracted from NotificationCenter (evaluateAndEnqueue).
 * The class method forwards private state through {@link EvaluateAndEnqueueHost}.
 */

import { unresolvableButtons } from './action-buttons.js'
import type { NcAlarmMatchPhase, NcAlarmPushVerdict } from './alarm/alarm-push-policy.js'
import { intrusionDeviceOf } from './alarm/alarm-push-policy.js'
import { NcDeviceStateCache } from './device-state-cache.js'
import type {
  NcEventOrigin,
  NcIncomingEvent,
  NcIntakeControls,
  NcIntakeReport,
  NcRuleOutcome,
} from './event-intake.js'
import { deliveryForKind } from './event-intake.js'
import type { NcGroupedAdmissionOutcome } from './grouped/grouped-delivery.js'
import { NcGroupedDelivery } from './grouped/grouped-delivery.js'
import type { NcOutboxGroupV2 } from './grouped/grouped-payload.js'
import { NcLinkedStillShelf } from './linked-stills.js'
import type { NcCooldownStamp, NcOutboxAlarmIntrusion, NcOutboxEnqueueInput } from './outbox.js'
import { NcOutbox } from './outbox.js'
import type {
  NcDeviceStateLookup,
  NcEvaluation,
  NcRuleSubject,
  NcSubjectKind,
} from './rule-engine.js'
import {
  cooldownKey,
  evaluateRule,
  isCoolingDown,
  isLinkedSetSubject,
  ruleShipsNoStill,
} from './rule-engine.js'
import { NcRuleStore } from './rule-store.js'
import { NcSceneStateCache } from './scene-state-cache.js'
import { NcSequenceStore } from './sequence-store.js'
import { NcStillShelf } from './still-shelf.js'
import { NcZoneOwnershipCache } from './zone-owner-cache.js'
import type { IScopedLogger, NcRule, NcRuleTarget } from '@camstack/types'
import { isSystemEventSummaryRule, ruleGroupingApplies } from '@camstack/types'

/**
 * What a GROUPED close (D692) adds to `buildEntries`, as ONE options object rather than
 * more positional parameters.
 */
export interface NcBuildEntriesExtras {
  /** The v2 group the row speaks for (§6.1), written for every N >= 1 (C7). */
  readonly groupV2?: NcOutboxGroupV2
  /** The window key: the row's dedup reference, wins over the track (D694). */
  readonly dedupRef?: string
  /** Every per-class cooldown stamp the close is about to write (§3.6). */
  readonly cooldowns?: readonly NcCooldownStamp[]
  /** D706: an alarm rule's push during an intrusion — titled with these locations. */
  readonly alarmIntrusion?: NcOutboxAlarmIntrusion
}
/**
 * D692: the in-process outcome of a grouped admission (the tester report and the specs
 * read it). Nothing is enqueued at admission — the window's close sends.
 */
export function groupedRuleOutcome(
  rule: NcRule,
  grouped: Exclude<NcGroupedAdmissionOutcome, { readonly kind: 'no-match' | 'plain' }>,
): NcRuleOutcome {
  // Review T8 L-1: the subject's own verdict, never one derived from the outcome kind —
  // a candidate in a window did not match (yet), and says so with `pending`.
  const admitted =
    grouped.kind === 'opened' || grouped.kind === 'joined' || grouped.kind === 'updated'
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    matched: grouped.matched,
    ...(admitted && !grouped.matched ? { pending: true as const } : {}),
    ...(grouped.matchedOn !== undefined ? { matchedOn: [...grouped.matchedOn] } : {}),
    cooldown:
      grouped.kind === 'cooling-down' ? 'suppressed' : grouped.kind === 'refused' ? 'n/a' : 'clear',
    enqueued: grouped.kind === 'tested' ? grouped.enqueued : 0,
    targetIds: [],
    grouped: grouped.kind,
  }
}

export interface EvaluateAndEnqueueHost {
  alarmPushVerdict(rule: NcRule, deviceId: number, phase: NcAlarmMatchPhase): NcAlarmPushVerdict
  buildEntries(
    rule: NcRule,
    subject: NcRuleSubject,
    kind: NcSubjectKind,
    matchedOn: readonly string[] | undefined,
    userTargets: readonly NcRuleTarget[],
    origin: NcEventOrigin,
    cooldown?: { readonly key: string; readonly at: number },
    extras?: NcBuildEntriesExtras,
  ): readonly NcOutboxEnqueueInput[]
  deviceStateLookup(read: (deviceId: number) => string | undefined): NcDeviceStateLookup
  readonly deviceStates: NcDeviceStateCache
  enqueuePickerTargets(
    event: NcIncomingEvent,
    reached: ReadonlySet<string>,
    outcomes: NcRuleOutcome[],
  ): Promise<void>
  readonly grouped: NcGroupedDelivery
  intrusionLocationsOf(deviceIds: readonly number[]): readonly string[]
  readonly lastFiredAt: Map<string, number>
  readonly linkedStills: NcLinkedStillShelf | null
  readonly logger: IScopedLogger
  mutedAuthority(subject: NcRuleSubject): number | undefined
  readonly now: () => number
  readonly outbox: NcOutbox
  reportMutedDrop(
    subject: NcRuleSubject,
    mutedDeviceId: number,
    kind: NcSubjectKind,
    now: number,
  ): void
  reportNoMatch(
    subject: NcRuleSubject,
    kind: NcSubjectKind,
    rejections: readonly string[],
    now: number,
  ): void
  reportRuleNonMatch(
    rule: NcRule,
    subject: NcRuleSubject,
    kind: NcSubjectKind,
    evaluation: NcEvaluation,
    outcomes: NcRuleOutcome[],
    rejections: string[],
  ): void
  resolveUserTargets(rule: NcRule, deviceId: number): Promise<readonly NcRuleTarget[]>
  readonly rules: NcRuleStore
  runRuleActions(
    rule: NcRule,
    subject: NcRuleSubject,
    kind: NcSubjectKind,
    controls: NcIntakeControls,
  ): NcAlarmMatchPhase
  readonly sceneGateReported: Map<string, string>
  readonly sceneStates: NcSceneStateCache
  readonly sequences: NcSequenceStore
  readonly stills: NcStillShelf | null
  readonly zoneOwners: NcZoneOwnershipCache
}

export async function evaluateAndEnqueue(
  host: EvaluateAndEnqueueHost,
  event: NcIncomingEvent,
): Promise<NcIntakeReport> {
  const { subject, kind, origin } = event
  const controls: NcIntakeControls = event.controls ?? {}
  const outcomes: NcRuleOutcome[] = []
  const report = (extra: Partial<NcIntakeReport> = {}): NcIntakeReport => ({
    recordId: subject.recordId,
    kind,
    delivery: deliveryForKind(kind),
    origin,
    candidates: 0,
    outcomes,
    ...extra,
  })
  // D692: a closed track's member is FINAL (spec §4) and carries its closed label —
  // before the mute, so a muted camera's member still becomes final.
  if (kind === 'track-end') {
    try {
      await host.grouped.onTrackClosed(subject)
    } catch (err) {
      // Review T8 M-2: a grouped failure never costs the track-end rules below.
      host.logger.warn('grouped track close failed — the track-end rules still run', {
        tags: { deviceId: subject.deviceId },
        meta: {
          eventId: subject.recordId,
          ...(subject.trackId !== undefined ? { trackId: subject.trackId } : {}),
          error: String(err),
        },
      })
    }
  }
  // ── Per-camera mute: the `notifications` switch of the function group ──
  //
  // Deliberately the FIRST gate, before any rule is evaluated: the operator
  // said "this camera never notifies", and evaluating rules to then discard
  // every result would spend the work and produce a `rule matched` line for
  // a notification nobody will ever receive.
  //
  // It is logged at INFO, not debug, and rate-limited per camera on the same
  // window as `event matched NO rule`. A branch that drops work silently
  // reads as "never happened" — which is how a live rule went fifteen hours
  // unable to fire, and how a notification centre that had never delivered
  // anything looked healthy.
  // A sensor-level LINKED SET is the SENSOR's event: judged on the sensor, a
  // muted camera having already been left out of it (`onSensorEvent`) —
  // unless the change took timeline rows and EVERY row camera is muted,
  // which drops it exactly as each of those rows would have been dropped.
  const muteDeviceId = host.mutedAuthority(subject)
  if (muteDeviceId !== undefined && controls.bypassMute !== true) {
    host.reportMutedDrop(subject, muteDeviceId, kind, host.now())
    return report({ droppedBy: 'muted' })
  }

  // Each subject kind maps onto a delivery value. `object-event` and
  // `audio-event` both ride the `immediate` delivery (classified audio has no
  // delivery enum of its own — it is gated by the audio-class opt-in instead);
  // `occupancy-event` rides `device-event` (state-edge, gated by the occupancy
  // condition — and, unlike audio, `device-event` is a native history member,
  // so no history downgrade is needed).
  const delivery = deliveryForKind(kind)
  const enabled = host.rules.listEnabled(delivery)
  // `onlyRuleId` narrows WHICH rules are looked at; it never changes a
  // verdict. The narrowing is a property of the producer's request, not of
  // the event — `evaluateRule` below is called with exactly the same
  // arguments it would get on the live path.
  const candidates =
    controls.onlyRuleId !== undefined
      ? enabled.filter((r) => r.id === controls.onlyRuleId)
      : enabled
  if (candidates.length === 0) {
    // A subject nobody is listening for is the NORMAL case, but it is also
    // indistinguishable from "the rules never loaded" — say which.
    host.logger.debug('no enabled rule for this trigger', {
      tags: { deviceId: subject.deviceId },
      meta: { delivery, kind, origin, rulesLoaded: host.rules.list().length },
    })
    await host.enqueuePickerTargets(event, new Set(), outcomes)
    if (outcomes.some((outcome) => outcome.enqueued > 0)) return report({ candidates: 0 })
    return report({ droppedBy: 'no-candidate-rule' })
  }
  const now = host.now()
  let anyMatched = false
  /** One "no media owner" line per EVENT, not per matching rule. */
  let noOwnerReported = false
  const rejections: string[] = []
  for (const rule of candidates) {
    // D692: a grouped rule's object event goes to its window (match OR candidate).
    if (kind === 'object-event' && rule.groupingSec !== undefined) {
      if (ruleGroupingApplies(rule)) {
        let grouped: NcGroupedAdmissionOutcome
        try {
          grouped = await host.grouped.admit(rule, subject, controls, origin)
        } catch (err) {
          // Review T8 M-2: one grouped rule's failure never costs the other rules of this
          // event — and it is never silent.
          host.logger.warn('grouped admission failed — the rule is skipped for this event', {
            tags: { deviceId: subject.deviceId },
            meta: {
              ruleId: rule.id,
              rule: rule.name,
              eventId: subject.recordId,
              ...(subject.trackId !== undefined ? { trackId: subject.trackId } : {}),
              error: String(err),
            },
          })
          continue
        }
        if (grouped.kind === 'no-match') {
          // Exactly today's non-match reporting, on the FULL evaluation `admit` made.
          host.reportRuleNonMatch(rule, subject, kind, grouped.evaluation, outcomes, rejections)
          continue
        }
        if (grouped.kind !== 'plain') {
          outcomes.push(groupedRuleOutcome(rule, grouped))
          if (grouped.kind !== 'refused' || grouped.why === 'already-notified') anyMatched = true
          continue
        }
        // C17: no track — the plain immediate path below, for this rule and this event.
      } else {
        // Spec §2.2: inert, said once per rule; the plain path below, unchanged.
        host.grouped.noteInertRule(rule, subject.deviceId)
      }
    }
    const evaluation = evaluateRule(
      rule,
      subject,
      host.deviceStateLookup((id) => host.deviceStates.get(id)),
      (id) => host.zoneOwners.get(id),
      (sceneId) => host.sceneStates.get(sceneId),
    )
    if (!evaluation.matched) {
      host.reportRuleNonMatch(rule, subject, kind, evaluation, outcomes, rejections)
      continue
    }
    // A STATE-SUMMARY rule (D647) matched: it says nothing now — its summary
    // reports the state at the end of its window. The match still COUNTS
    // (`matched: true`), so a battery raise it covers is heard and not kept
    // pending, and every other rule on the same kinds is untouched.
    if (isSystemEventSummaryRule(rule)) {
      host.logger.debug('rule matched — held for its scheduled state summary', {
        tags: { deviceId: subject.deviceId },
        meta: {
          ruleId: rule.id,
          rule: rule.name,
          kind: subject.systemEvent?.kind,
          eventId: subject.recordId,
        },
      })
      outcomes.push({
        ruleId: rule.id,
        ruleName: rule.name,
        matched: true,
        ...(evaluation.matchedOn !== undefined ? { matchedOn: [...evaluation.matchedOn] } : {}),
        cooldown: 'n/a',
        enqueued: 0,
        targetIds: [],
        heldForSummary: true,
      })
      anyMatched = true
      continue
    }
    // The rule fired, so the NEXT suppression is a new fact and owes its own
    // line — even when its reason is the one already reported. Without this,
    // a scene that flapped would be logged once and then never again.
    host.sceneGateReported.delete(rule.id)
    // ── ACTUATE FIRST, and BEFORE the cooldown gate ──────────────────
    //
    // The cooldown is a budget for NOTIFICATIONS — "do not tell me about
    // this camera more than once a minute". It was also, silently, a budget
    // for physical actions: the `continue` below skipped the actuation too,
    // so a second intruder inside the window did not arm the alarm, did not
    // open the gate and did not sound the siren. The sequence runner's own
    // `minDelaySec` exists precisely because "how often may this gate
    // physically move" is a different question, and it was unreachable.
    //
    // Fire-and-forget: an actuation is slower than an enqueue (it can
    // contain a `wait`), and a notification must never queue behind a gate
    // opening. The runner never throws and logs its own failures.
    //
    // `runActions === false` is the ONE thing a synthetic injection turns off
    // by default: a rule's sequence opens gates and unlocks doors, and an
    // operator checking what a notification looks like has not asked for
    // that. Every live producer omits the control and keeps running them.
    const alarmPhase = host.runRuleActions(rule, subject, kind, controls)
    // ── D706: an ALARM rule's own push follows where the alarm stood ──────
    //
    // The match that starts the entry delay is told by the entry-delay notification, and
    // a match during the delay rides the triggered notification's mosaic (D705) — unless
    // the mode asks for them. Never silent: each suppression is a line on the camera.
    const alarmPush = host.alarmPushVerdict(rule, subject.deviceId, alarmPhase)
    if (alarmPush.kind === 'suppress') {
      host.logger.info('alarm rule push not sent — the alarm notification speaks for it', {
        tags: { deviceId: subject.deviceId },
        meta: {
          ruleId: rule.id,
          rule: rule.name,
          reason: alarmPush.reason,
          phase: alarmPhase.kind,
          eventId: subject.recordId,
          ...(subject.trackId !== undefined ? { trackId: subject.trackId } : {}),
          ...(subject.sourceDeviceId !== undefined
            ? { sensorDeviceId: subject.sourceDeviceId }
            : {}),
        },
      })
      outcomes.push({
        ruleId: rule.id,
        ruleName: rule.name,
        matched: true,
        ...(evaluation.matchedOn !== undefined ? { matchedOn: [...evaluation.matchedOn] } : {}),
        cooldown: 'n/a',
        enqueued: 0,
        targetIds: [],
        alarmSuppressed: alarmPush.reason,
      })
      anyMatched = true
      continue
    }
    const alarmIntrusion: NcOutboxAlarmIntrusion | undefined =
      alarmPush.kind === 'intrusion'
        ? { locations: host.intrusionLocationsOf([intrusionDeviceOf(subject)]) }
        : undefined
    const key = cooldownKey(rule, subject)
    const cooling = isCoolingDown(rule, host.lastFiredAt.get(key), now)
    if (cooling && controls.bypassCooldown !== true) {
      host.logger.debug('rule matched but is cooling down', {
        tags: { deviceId: subject.deviceId },
        meta: {
          ruleId: rule.id,
          rule: rule.name,
          key,
          eventId: subject.recordId,
          ...(subject.trackId !== undefined ? { trackId: subject.trackId } : {}),
        },
      })
      outcomes.push({
        ruleId: rule.id,
        ruleName: rule.name,
        matched: true,
        ...(evaluation.matchedOn !== undefined ? { matchedOn: [...evaluation.matchedOn] } : {}),
        cooldown: 'suppressed',
        enqueued: 0,
        targetIds: [],
      })
      continue
    }
    host.logger.info('rule matched — enqueueing', {
      tags: { deviceId: subject.deviceId },
      meta: {
        ruleId: rule.id,
        rule: rule.name,
        kind,
        // The producer's marker. It reaches every line this evaluation
        // prints and the outbox row it inserts, and it is readable NOWHERE
        // the matcher can see it — see `event-intake.ts`.
        origin,
        targets: rule.targets.length,
        // The detection that caused this. `ruleId` alone says which rule
        // fired, never on what — tracing a delivered notification back to
        // its event meant hand-correlating timestamps, and that cost real
        // time during the 2026-07-30 investigation.
        eventId: subject.recordId,
        ...(subject.trackId !== undefined ? { trackId: subject.trackId } : {}),
        ...(subject.confidence !== undefined ? { confidence: subject.confidence } : {}),
        ...(subject.zones.length > 0 ? { zones: subject.zones } : {}),
        // A rule that names one edge of a sensor fired on THIS reading. `null`
        // is the fail-open pass (D640): the slice could not say which way the
        // sensor moved, so the edge filter let it through — said, not silent.
        ...(rule.conditions.sensorTransition !== undefined
          ? {
              sensorTransition: rule.conditions.sensorTransition,
              sensorRaised: subject.sensorRaised ?? null,
            }
          : {}),
      },
    })
    // A button naming a sequence the rule does not have never reaches a
    // phone. Say so ONCE per fire rather than never: the operator authored
    // it, and a button that silently does not appear is unreportable.
    const unresolvable = unresolvableButtons(rule.actions, host.sequences.knownIds())
    if (unresolvable.length > 0) {
      host.logger.warn('rule buttons reference sequences that do not exist — not sent', {
        tags: { deviceId: subject.deviceId },
        meta: { ruleId: rule.id, rule: rule.name, buttons: unresolvable.join(', ') },
      })
    }
    // A device event's ONLY picture is the marker track the same press
    // projected (`sensor-marker-projector.ts`). No marker ⇒ nothing owns a
    // frame of this event ⇒ the notification is text-only, and that must be
    // a line rather than a silence: "why did the doorbell arrive without a
    // photo" is asked per camera, and it was unanswerable for months. Once
    // per event, not per rule, and only when a rule that fired wanted media.
    //
    // An UNOWNED sensor (`linkedCameraIds` set, the sensor its own device)
    // has no marker BY DESIGN — no camera took a row, so none projected a
    // frame — so it is a `debug` line saying which case it is, not a warn
    // claiming a marker went missing. A LINKED SET with shelf owners names
    // photographs, not a marker, and the shelf's own per-event line says
    // whether they landed (`linked-stills.ts`); one WITHOUT them had no
    // capture to start (no snapshot cap here) and says so on the sensor.
    if (
      !noOwnerReported &&
      kind === 'device-event' &&
      subject.trackId === undefined &&
      subject.linkedStills === undefined &&
      !ruleShipsNoStill(rule)
    ) {
      noOwnerReported = true
      const linked = subject.linkedCameraIds
      const meta = {
        recordId: subject.recordId,
        ...(subject.sensorKind !== undefined ? { sensorKind: subject.sensorKind } : {}),
        ruleId: rule.id,
        rule: rule.name,
      }
      if (linked !== undefined && linked.length === 0 && isLinkedSetSubject(subject)) {
        // Every linked camera muted: the operator's choice, not a picture
        // that went missing — each camera already said so on itself.
        host.logger.info(
          'every linked camera is muted — this sensor notification ships text-only',
          {
            tags: { deviceId: subject.linkedSensorId ?? subject.deviceId },
            meta,
          },
        )
      } else if (linked !== undefined && isLinkedSetSubject(subject)) {
        host.logger.warn(
          'sensor event has no linked-camera pictures and no marker — this notification ships text-only',
          {
            tags: { deviceId: subject.sourceDeviceId ?? subject.deviceId },
            meta: {
              ...meta,
              linkedCameraIds: [...linked],
              snapshotWired: host.linkedStills !== null,
            },
          },
        )
      } else if (linked !== undefined) {
        host.logger.debug(
          linked.length === 0
            ? 'device event from a sensor linked to no camera — this notification ships text-only'
            : `device event from a sensor linked to ${linked.length} camera(s), none opted into tracked events — this notification ships text-only`,
          {
            tags: { deviceId: subject.deviceId },
            meta: { ...meta, linkedCameraIds: [...linked] },
          },
        )
      } else {
        host.logger.warn('device event has no marker track — this notification ships text-only', {
          tags: { deviceId: subject.deviceId },
          meta,
        })
      }
    }
    // The audio counterpart, and the same argument: a sound rule's only
    // picture is the photograph the confirmation started (`still-shelf.ts`),
    // so no owner means this node has no snapshot cap wired at all — the one
    // state in which asking for a still can never be answered. Text-only is
    // then the right delivery and a silent one is not.
    if (
      !noOwnerReported &&
      (kind === 'audio-window' || kind === 'audio-event') &&
      subject.trackId === undefined &&
      !ruleShipsNoStill(rule)
    ) {
      noOwnerReported = true
      host.logger.warn('audio match has no still owner — this notification ships text-only', {
        tags: { deviceId: subject.deviceId },
        meta: {
          recordId: subject.recordId,
          kind,
          ruleId: rule.id,
          rule: rule.name,
          snapshotWired: host.stills !== null,
        },
      })
    }
    const userTargets = await host.resolveUserTargets(rule, subject.deviceId)
    const entries = host.buildEntries(
      rule,
      subject,
      kind,
      evaluation.matchedOn,
      userTargets,
      origin,
      // The same `(key, now)` pair the line below writes into the map — so a
      // rollback releases EXACTLY this window and no other.
      { key, at: now },
      alarmIntrusion !== undefined ? { alarmIntrusion } : undefined,
    )
    const inserted = await host.outbox.enqueue(entries)
    // One fire = one cooldown tick, shared across the rule's targets;
    // a full dedup hit (maxPerTrack already satisfied) is NOT a fire.
    // A bypassed window is NOT consumed either: a test must not silence the
    // real notification that would have come a second later.
    if (inserted > 0 && controls.bypassCooldown !== true) host.lastFiredAt.set(key, now)
    outcomes.push({
      ruleId: rule.id,
      ruleName: rule.name,
      matched: true,
      ...(evaluation.matchedOn !== undefined ? { matchedOn: [...evaluation.matchedOn] } : {}),
      cooldown: cooling ? 'bypassed' : 'clear',
      enqueued: inserted,
      targetIds: entries.map((e) => e.targetId),
    })
    anyMatched = true
  }

  // Nothing fired. The per-rule verdicts above are `debug`, and debug does not
  // reach the log pipeline — which is why a rule that had stopped matching
  // ENTIRELY went unnoticed for fifteen hours on 2026-07-31, and was found
  // only by comparing against another system.
  //
  // So one INFO line when an event interests NOBODY, naming each rule and the
  // condition that rejected it. Rate-limited per `noMatchReportKey` bucket —
  // device, subject kind and CLASS SET — because a busy camera would otherwise
  // print this for every event: the first is reported at once, further ones
  // are counted and folded into the next report. The class set is in the key
  // because keying on the device alone let a person's verdict answer for a
  // cat's on the same camera, and the silence read as "never evaluated" (D390).
  if (!anyMatched && rejections.length > 0) {
    host.reportNoMatch(subject, kind, rejections, now)
  }
  const reached = new Set(outcomes.flatMap((outcome) => outcome.targetIds))
  await host.enqueuePickerTargets(event, reached, outcomes)
  return report({ candidates: candidates.length })
}
