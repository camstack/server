/**
 * Extracted from NotificationCenter (buildEntries, resolveUserTargets, reportMutedDrop, reportNoMatch, reportRuleNonMatch).
 * The class method forwards private state through {@link BuildEntriesHost}.
 */

import { alarmIncidentGroup } from './alarm/alarm-incident-group.js'
import { ruleCropZoneIds } from './close-grouped-pass.js'
import { frozenConfirmPolicy } from './confirm-policy.js'
import { NcDeviceMuteStore } from './device-mute-store.js'
import type { NcBuildEntriesExtras } from './evaluate-and-enqueue.js'
import type { NcEventOrigin, NcRuleOutcome } from './event-intake.js'
import { linkedCameraMode, linkedMediaOwners } from './linked-camera-media.js'
import { noMatchReportKey } from './no-match-report-key.js'
import type { NcOutboxEnqueueInput, NcOutboxOccupancySubject, NcOutboxPayload } from './outbox.js'
import { frozenRuleAiPolicy } from './rule-ai-policy.js'
import { NcRuleAiStore } from './rule-ai-store.js'
import type {
  NcEvaluation,
  NcOccupancySubject,
  NcRuleSubject,
  NcSubjectKind,
  NcSystemEventExcludingFilter,
} from './rule-engine.js'
import { effectiveMediaPolicyForRule, isLinkedSetSubject } from './rule-engine.js'
import { NcRuleStore } from './rule-store.js'
import type { IScopedLogger, NcConditions, NcRule, NcRuleTarget } from '@camstack/types'
import type { NotificationCenterDeps } from './index.js'

/** The user slice the rule→user fan-out needs. */
export interface NcUserGrant {
  readonly id: string
  readonly isAdmin: boolean
  readonly allowedDevices: Readonly<Record<string, readonly string[] | '*'>>
}
/** The media half of an outbox payload — what a rule's media policy freezes. */
export type NcMediaPolicyFields = Pick<
  NcOutboxPayload,
  | 'media'
  | 'mediaImage'
  | 'mediaShowTriggerZone'
  | 'mediaShowSubjectPath'
  | 'triggerZoneIds'
  | 'matchedZoneIds'
  | 'mediaProfile'
  | 'mediaGif'
  | 'mediaClip'
  | 'mediaClipPreRollSec'
  | 'mediaClipSpeed'
  | 'mediaClipPostRollSec'
>
/**
 * A rule's media policy, as the fields a row freezes — ONE derivation, used by
 * every row a rule addresses AND by the alarm's own announcement row when it is
 * the COMBINED siren (the triggering rule's pictures on the alarm's words).
 *
 * `effectiveMediaPolicyForRule` resolves the picture MODE (D897) — a sensor
 * rule's included: it goes through the same selector and render stage as a
 * detection rule. `triggerZoneIds` are the zones of the rule that owns the
 * media (the SOURCE rule of a combined alarm row), and a zone overlay is
 * frozen only when the rule asked for one AND fired on a zone.
 */
export function mediaPolicyFields(
  mediaRule: NcRule,
  cropZoneIds: readonly string[] | undefined,
  matchedZoneIds: readonly string[] | undefined,
): NcMediaPolicyFields {
  const media = effectiveMediaPolicyForRule(mediaRule)
  const image = media.image ?? 'crop'
  return {
    // `media` keeps its one remaining meaning on the row: does it ship a still.
    media: image === 'none' ? 'none' : 'best',
    mediaImage: image,
    ...(media.showTriggerZone === true && cropZoneIds !== undefined && cropZoneIds.length > 0
      ? { mediaShowTriggerZone: true as const }
      : {}),
    ...(media.showSubjectPath === true && image !== 'none'
      ? { mediaShowSubjectPath: true as const }
      : {}),
    // The zones the CONDITION matched on — frozen whether or not the rule
    // asked for a zone crop, because the still ladder needs them to avoid
    // attaching a frame from after the subject left. Same source as the crop
    // ids (the zone condition, or occupancy's own scoped zone).
    ...(cropZoneIds !== undefined ? { triggerZoneIds: [...cropZoneIds] } : {}),
    // The ones of those THIS event triggered — the only zones the overlay draws.
    ...(matchedZoneIds !== undefined ? { matchedZoneIds: [...matchedZoneIds] } : {}),
    ...(media.profile !== undefined ? { mediaProfile: media.profile } : {}),
    ...(media.gif === true ? { mediaGif: true } : {}),
    ...(media.clip === true ? { mediaClip: true } : {}),
    ...(media.clipPreRollSec !== undefined ? { mediaClipPreRollSec: media.clipPreRollSec } : {}),
    ...(media.clipSpeed !== undefined ? { mediaClipSpeed: media.clipSpeed } : {}),
    ...(media.clipPostRollSec !== undefined ? { mediaClipPostRollSec: media.clipPostRollSec } : {}),
  }
}
export const NO_MATCH_REPORT_INTERVAL_MS = 60_000
/**
 * Freeze the matched occupancy edge onto the outbox payload subject (A5) — the
 * source of the dispatcher's `{{zone}}`/`{{count}}`/`{{capacity}}` vars.
 *
 * `capacity` is the RULE's configured `occupancy.count`, NOT the edge's key
 * threshold: a `<=C` rule keys on threshold `C+1`, so the threshold would
 * misreport the operator's capacity by one. The rule condition is present by
 * construction (the engine's occupancy branch fires only when it is); the
 * threshold fallback keeps the freeze total without a cast, and is exact for
 * every op but `<=`.
 */
export function frozenOccupancy(rule: NcRule, occ: NcOccupancySubject): NcOutboxOccupancySubject {
  return {
    ...(occ.zoneName !== undefined ? { zone: occ.zoneName } : {}),
    count: occ.count,
    capacity: rule.conditions.occupancy?.count ?? occ.threshold,
    occupied: occ.occupied,
  }
}
export function notificationZones(rule: NcRule, subject: NcRuleSubject): readonly string[] {
  const configured = rule.conditions.zones?.ids
  if (configured === undefined || configured.length === 0) return subject.zones
  const allowed = new Set(configured)
  return subject.zones.filter((zoneId) => allowed.has(zoneId))
}
/**
 * The zone ids a rule freezes for its crop and its still narrowing (D223): the zone
 * condition's ids, else an occupancy rule's one zone. A grouped member freezes the same
 * ids a plain row of the rule would.
 */
/**
 * The zones of `cropZoneIds` this subject actually triggered — what the zone
 * condition saw (membership plus the crossed zone, `zonesVisitedBy`), on the
 * rule whose media the row carries. On a combined alarm row the subject is the
 * alarm, so the source match's frozen zones answer. An occupancy rule's one
 * zone is the zone the count edge is ABOUT, so it is its own trigger.
 */
export function matchedTriggerZoneIds(
  mediaRule: NcRule,
  cropZoneIds: readonly string[] | undefined,
  subject: NcRuleSubject,
): readonly string[] | undefined {
  if (cropZoneIds === undefined) return undefined
  if (mediaRule.conditions.zones === undefined) return [...cropZoneIds]
  const alarmSource = subject.systemEvent?.alarmSource
  const visited = new Set<string>(
    alarmSource !== undefined ? (alarmSource.zones ?? []) : subject.zones,
  )
  if (alarmSource === undefined && subject.crossing !== undefined) {
    visited.add(subject.crossing.zoneId)
  }
  return cropZoneIds.filter((id) => visited.has(id))
}

export interface BuildEntriesHost {
  readonly deps: NotificationCenterDeps
  readonly deviceMutes: NcDeviceMuteStore
  readonly deviceRouteCache: Map<number, { stableId: string; addonId: string } | null>
  readonly lastMutedReportAt: Map<string, number>
  readonly lastNoMatchReportAt: Map<string, number>
  readonly logger: IScopedLogger
  readonly mutedSuppressed: Map<string, number>
  readonly noMatchSuppressed: Map<string, number>
  readonly now: () => number
  ownedTargetsAt: number
  ownedTargetsCache: ReadonlyMap<string, readonly string[]> | null
  reportSceneSuppression(
    rule: { readonly id: string; readonly name: string; readonly conditions: NcConditions },
    subject: NcRuleSubject,
  ): void
  reportSystemFilterExclusion(
    rule: { readonly id: string; readonly name: string },
    subject: NcRuleSubject,
    filter: NcSystemEventExcludingFilter,
  ): void
  readonly ruleAi: NcRuleAiStore
  readonly rules: NcRuleStore
  userFanoutUnavailableLogged: boolean
  userGrantsAt: number
  userGrantsCache: readonly NcUserGrant[] | null
}

export function buildEntries(
  host: BuildEntriesHost,
  rule: NcRule,
  subject: NcRuleSubject,
  kind: NcSubjectKind,
  matchedOn: readonly string[] | undefined,
  userTargets: readonly NcRuleTarget[] = [],
  origin: NcEventOrigin = 'pipeline',
  cooldown?: { readonly key: string; readonly at: number },
  extras?: NcBuildEntriesExtras,
): readonly NcOutboxEnqueueInput[] {
  // Event-owned media resolves by `eventId` (the object/package event id);
  // device events have none. Track-scoped triggers dedup per track
  // (maxPerTrack:1); discrete device/package events dedup per record, so a
  // delivery + a pick-up on ONE source track are never collapsed into one —
  // and a record keyed on a reusable rowid dedups on its generation
  // (`outbox-key.ts`, D694), never on the id alone.
  const hasEventMedia = kind === 'object-event' || kind === 'package-event'
  const isTrackScoped = kind === 'object-event' || kind === 'track-end'
  const isSystemEvent = kind === 'system-event'
  // ── THE COMBINED ALARM NOTIFICATION ──────────────────────────────────
  //
  // A system event carries no media of its own, and that is right for every
  // one of them but this: an alarm a rule set off owns the very frames that
  // set it off. So the row takes the ALARM's words and the TRIGGERING rule's
  // media policy and subject — one row, one push, with the picture on it.
  //
  // The media policy is the source rule's, never this rule's: the rule that
  // says "notify me when the alarm goes off" is a system-event rule and has
  // no media policy worth the name, while the rule that matched the intruder
  // was authored with one. A source rule that has since been deleted falls
  // back to this rule, i.e. to no media — degraded, never broken.
  const alarmSource = subject.systemEvent?.alarmSource
  const mediaRule = alarmSource !== undefined ? (host.rules.get(alarmSource.ruleId) ?? rule) : rule
  const noMedia = isSystemEvent && alarmSource === undefined
  // Per-target opt-out is applied HERE, at enqueue: an opted-out target gets
  // no outbox row at all — so history carries no false `sent` claim for a
  // notification the user asked never to receive. (The dispatcher keeps a
  // deliver-time opt-out gate as defense-in-depth for rows enqueued before an
  // opt-out toggle.) An ALL-opted-out fire yields zero entries → the caller's
  // `inserted > 0` gate then leaves the cooldown unconsumed.
  // Rule targets + the user fan-out, deduped by target id (a target both
  // addressed directly and owned by an addressed user sends ONCE). The
  // per-user opt-out filter below applies to the merged set, so a user's
  // disabledTargetIds silence their fanned-out targets too.
  const direct = new Set(rule.targets.map((t) => t.targetId))
  const renderedZones = notificationZones(rule, subject)
  const confirm = frozenConfirmPolicy(rule, isSystemEvent)
  // The zones of the rule whose MEDIA this row carries: on a combined alarm
  // row that is the source rule, not the system rule that says "the alarm
  // went off" — which has no zone and used to strip the PLACE filter and the
  // zone overlay from the one push the incident gets (D897).
  const cropZoneIds = ruleCropZoneIds(mediaRule)
  const matchedZoneIds = matchedTriggerZoneIds(mediaRule, cropZoneIds, subject)
  const allTargets = [...rule.targets, ...userTargets.filter((t) => !direct.has(t.targetId))]
  const linkedOwners =
    !noMedia && subject.linkedStills !== undefined
      ? linkedMediaOwners(subject.linkedStills, linkedCameraMode(mediaRule.media))
      : undefined
  // D692's group, or — on a combined alarm-triggered row whose entry delay saw more than one
  // subject — the incident as one (D705): the same field, the same mosaic path.
  const groupV2 =
    extras?.groupV2 ??
    (subject.systemEvent !== undefined && !noMedia
      ? alarmIncidentGroup(subject.systemEvent, subject.timestamp)
      : undefined)
  return allTargets
    .filter((target) => !rule.disabledTargetIds.includes(target.targetId))
    .map((target) => {
      const base: NcOutboxPayload = {
        ruleName: rule.name,
        delivery: rule.delivery,
        // The marker, frozen on the durable row: a row an operator injected
        // is identifiable forever after in the outbox and in history. It is
        // stamped only when it is TRUE, so every pre-existing row keeps
        // reading exactly as it did.
        ...(origin === 'synthetic' ? { synthetic: true as const } : {}),
        priority: rule.priority,
        ...(rule.template !== undefined ? { template: rule.template } : {}),
        ...(noMedia
          ? { media: 'none' as const }
          : mediaPolicyFields(mediaRule, cropZoneIds, matchedZoneIds)),
        ...(confirm !== undefined
          ? {
              confirm,
              ...(cooldown !== undefined ? { cooldown } : {}),
              ...(extras?.cooldowns !== undefined && extras.cooldowns.length > 0
                ? { cooldowns: extras.cooldowns }
                : {}),
            }
          : {}),
        ...(matchedOn !== undefined && matchedOn.length > 0 ? { matchedOn } : {}),
        // D692: a grouped close's v2 group, written for N >= 1 (C7) — hydration and
        // the record read it; the dispatcher treats a group of one as a plain row.
        ...(groupV2 !== undefined ? { group: groupV2 } : {}),
        ...(extras?.alarmIntrusion !== undefined ? { alarmIntrusion: extras.alarmIntrusion } : {}),
        ...(target.params !== undefined ? { params: target.params } : {}),
        subject: {
          deviceId: subject.deviceId,
          // The media OWNERS. Ordinarily the subject's own; on a combined
          // alarm row they are the triggering detection's, which is the whole
          // point — the alarm event owns no frame of anything.
          // A SENSOR's linked set names shelf owners instead (ADR 0632): the
          // mosaic, or one still per camera, per THIS rule's policy.
          ...(alarmSource?.trackId !== undefined
            ? {
                trackId: alarmSource.trackId,
                ...(alarmSource.extraStills !== undefined && alarmSource.extraStills.length > 0
                  ? { extraStills: alarmSource.extraStills.map((x) => ({ ...x })) }
                  : {}),
              }
            : linkedOwners !== undefined
              ? {
                  trackId: linkedOwners.trackId,
                  ...(linkedOwners.extraStills.length > 0
                    ? { extraStills: linkedOwners.extraStills.map((x) => ({ ...x })) }
                    : {}),
                  analysisTiles: linkedOwners.analysisTiles.map((x) => ({ ...x })),
                }
              : subject.trackId !== undefined
                ? { trackId: subject.trackId }
                : {}),
          ...(subject.linkedCameraIds !== undefined &&
          subject.linkedCameraIds.length > 1 &&
          isLinkedSetSubject(subject)
            ? { linkedCameraIds: [...subject.linkedCameraIds] }
            : {}),
          ...(alarmSource?.eventId !== undefined
            ? { eventId: alarmSource.eventId }
            : hasEventMedia
              ? { eventId: subject.recordId }
              : {}),
          // Fall back to the sensor kind for device events (no detection class).
          className: subject.classNames[0] ?? subject.sensorKind ?? 'event',
          ...(subject.label !== undefined ? { label: subject.label } : {}),
          // Which SENTENCE this row gets — a recognised person and a read
          // plate are not the same phrase with a different noun in it.
          ...(subject.labelKind !== undefined ? { labelKind: subject.labelKind } : {}),
          ...(subject.confidence !== undefined ? { confidence: subject.confidence } : {}),
          zones: renderedZones,
          timestamp: subject.timestamp,
          // Frozen beside `timestamp`, never in place of it: the footage cut
          // is anchored on the moment the change HAPPENED, and this row may
          // drain minutes later.
          ...(subject.observedAt !== undefined ? { observedAt: subject.observedAt } : {}),
          ...(subject.occupancy !== undefined
            ? { occupancy: frozenOccupancy(rule, subject.occupancy) }
            : {}),
          // Which half of the parcel's life — frozen here because it picks
          // the sentence at delivery time, and the row may drain days later.
          ...(subject.packagePhase !== undefined ? { packagePhase: subject.packagePhase } : {}),
          ...(subject.packagePossible === true ? { packagePossible: true } : {}),
          // SOUND — what was heard, frozen for `{{sounds}}` / `{{hitPercent}}`
          // / `{{db}}`. `hitPercent` is LEVEL mode only.
          ...(subject.audioWindow !== undefined
            ? {
                audio: {
                  labels: subject.audioWindow.labels,
                  ...(subject.audioWindow.mode === 'level'
                    ? { hitPercent: subject.audioWindow.hitPercent }
                    : {}),
                  ...(subject.audioWindow.peakDbfs !== undefined
                    ? { peakDbfs: subject.audioWindow.peakDbfs }
                    : {}),
                },
              }
            : {}),
          // DEVICE-EVENT — the device's own token, for `{{eventType}}`.
          ...(subject.eventType !== undefined ? { eventType: subject.eventType } : {}),
          ...(subject.systemEvent !== undefined ? { systemEvent: subject.systemEvent } : {}),
        },
      }
      // AI NARRATION, frozen exactly as the confirm policy is — and derived
      // from the ROW rather than the rule, because which of the three
      // questions is worth asking is a property of what this row descends
      // from (`rule-ai-policy.ts`). Identical for every target of this fire:
      // the WORD CAP is the one part the target decides, and it is resolved
      // at send time for that reason.
      const aiPolicy = frozenRuleAiPolicy(host.ruleAi.get(rule.id), base, isSystemEvent)
      const payload: NcOutboxPayload = aiPolicy === undefined ? base : { ...base, ai: aiPolicy }
      return {
        ruleId: rule.id,
        targetId: target.targetId,
        deviceId: subject.deviceId,
        // Occupancy enqueues under `device-event` (a native `NcOutboxRecordKind`
        // + `NcHistoryRecordKind` member — no downgrade needed, unlike audio).
        recordKind: kind === 'occupancy-event' ? 'device-event' : kind,
        recordId: subject.recordId,
        ...(isTrackScoped && subject.trackId !== undefined ? { trackId: subject.trackId } : {}),
        // D692: a grouped row's dedup reference is its window key. Passed through, never
        // spelled here: `outboxEntryId` builds the id as for every other row (D694).
        ...(extras?.dedupRef !== undefined ? { dedupRef: extras.dedupRef } : {}),
        payload,
      }
    })
}
/**
 * The personal targets a rule's `targetUsers` resolve to for THIS device:
 * each addressed user contributes the enabled targets they own — but only
 * when their `allowedDevices` grant covers the firing camera (admin users
 * always pass). A user must never be notified about a device they cannot
 * open.
 */
export async function resolveUserTargets(
  host: BuildEntriesHost,
  rule: NcRule,
  deviceId: number,
): Promise<readonly NcRuleTarget[]> {
  const users = rule.targetUsers
  if (users === undefined || users.length === 0) return []
  const { listUsers, getDeviceRoute } = host.deps
  if (listUsers === undefined || getDeviceRoute === undefined) {
    if (!host.userFanoutUnavailableLogged) {
      host.userFanoutUnavailableLogged = true
      host.logger.warn('rule addresses users but the user fan-out deps are not wired', {
        meta: { ruleId: rule.id },
      })
    }
    return []
  }

  const now = host.now()
  if (host.userGrantsCache === null || now - host.userGrantsAt > 60_000) {
    host.userGrantsCache = await listUsers()
    host.userGrantsAt = now
  }
  if (host.ownedTargetsCache === null || now - host.ownedTargetsAt > 60_000) {
    const targets = await host.deps.dispatcher.listTargets()
    const owned = new Map<string, string[]>()
    for (const t of targets) {
      if (t.ownerUserId === undefined || !t.enabled) continue
      const list = owned.get(t.ownerUserId) ?? []
      list.push(t.id)
      owned.set(t.ownerUserId, list)
    }
    host.ownedTargetsCache = owned
    host.ownedTargetsAt = now
  }
  if (!host.deviceRouteCache.has(deviceId)) {
    host.deviceRouteCache.set(deviceId, await getDeviceRoute(deviceId))
  }
  const route = host.deviceRouteCache.get(deviceId) ?? null

  const out: NcRuleTarget[] = []
  for (const userId of users) {
    const user = host.userGrantsCache.find((u) => u.id === userId)
    if (user === undefined) continue
    if (!user.isAdmin) {
      // No resolvable route ⟹ the grant cannot be verified ⟹ do NOT send.
      if (route === null) continue
      const grant = user.allowedDevices[route.addonId]
      const allowed = grant === '*' || (Array.isArray(grant) && grant.includes(route.stableId))
      if (!allowed) continue
    }
    for (const targetId of host.ownedTargetsCache.get(userId) ?? []) {
      out.push({ targetId })
    }
  }
  return out
}
/**
 * One INFO line when a MUTED camera's event is dropped, bounded to one per
 * camera per window with the suppressed count folded into the next report —
 * identical shape to `reportNoMatch`, because the question an operator asks
 * is identical: "why did this camera not notify me?".
 */
export function reportMutedDrop(
  host: BuildEntriesHost,
  subject: NcRuleSubject,
  mutedDeviceId: number,
  kind: NcSubjectKind,
  now: number,
): void {
  const bucket = noMatchReportKey({
    deviceId: mutedDeviceId,
    kind,
    classNames: subject.classNames,
  })
  const last = host.lastMutedReportAt.get(bucket) ?? 0
  const suppressed = host.mutedSuppressed.get(bucket) ?? 0
  if (now - last < NO_MATCH_REPORT_INTERVAL_MS) {
    host.mutedSuppressed.set(bucket, suppressed + 1)
    return
  }
  host.lastMutedReportAt.set(bucket, now)
  host.mutedSuppressed.set(bucket, 0)
  // A linked set dropped because every camera that took its row is muted
  // is still the SENSOR's event: said on the sensor, naming those cameras.
  const rowsMuted =
    subject.linkedSensorId !== undefined && !host.deviceMutes.isMuted(subject.linkedSensorId)
  host.logger.info(
    subject.linkedSensorId === undefined
      ? 'notifications muted for this camera — event dropped before rule evaluation'
      : rowsMuted
        ? 'every camera that took its row is muted — sensor event dropped before rule evaluation'
        : 'notifications muted for this sensor — event dropped before rule evaluation',
    {
      tags: { deviceId: mutedDeviceId },
      meta: {
        kind,
        ...(rowsMuted ? { mutedRowCameraIds: [...(subject.mutedRowCameraIds ?? [])] } : {}),
        classes: subject.classNames,
        eventId: subject.recordId,
        ...(subject.trackId !== undefined ? { trackId: subject.trackId } : {}),
        ...(suppressed > 0 ? { alsoDroppedSinceLastReport: suppressed } : {}),
      },
    },
  )
}
/** See the call site. Bounded to one line per {@link noMatchReportKey} bucket
 *  per window — device, subject kind and class set, so one subject's verdict
 *  cannot stand in for another's on the same camera ([D390]). */
export function reportNoMatch(
  host: BuildEntriesHost,
  subject: NcRuleSubject,
  kind: NcSubjectKind,
  rejections: readonly string[],
  now: number,
): void {
  const bucket = noMatchReportKey({
    deviceId: subject.deviceId,
    kind,
    classNames: subject.classNames,
  })
  const last = host.lastNoMatchReportAt.get(bucket) ?? 0
  const suppressed = host.noMatchSuppressed.get(bucket) ?? 0
  if (now - last < NO_MATCH_REPORT_INTERVAL_MS) {
    host.noMatchSuppressed.set(bucket, suppressed + 1)
    return
  }
  host.lastNoMatchReportAt.set(bucket, now)
  host.noMatchSuppressed.set(bucket, 0)
  host.logger.info('event matched NO rule', {
    tags: { deviceId: subject.deviceId },
    meta: {
      kind,
      rejectedBy: rejections,
      classes: subject.classNames,
      ...(subject.confidence !== undefined ? { confidence: subject.confidence } : {}),
      ...(subject.zones.length > 0 ? { zones: subject.zones } : { zones: [] }),
      eventId: subject.recordId,
      ...(subject.trackId !== undefined ? { trackId: subject.trackId } : {}),
      ...(suppressed > 0 ? { alsoSuppressedSinceLastReport: suppressed } : {}),
    },
  })
}
/**
 * The report of ONE rule that did not match ONE subject — the plain path and the
 * grouped path (D692) share it, so a non-match is reported by one block.
 */
export function reportRuleNonMatch(
  host: BuildEntriesHost,
  rule: NcRule,
  subject: NcRuleSubject,
  kind: NcSubjectKind,
  evaluation: NcEvaluation,
  outcomes: NcRuleOutcome[],
  rejections: string[],
): void {
  // A branch that DROPS work silently logs it. `rule did not match` is a
  // DEBUG line and this hub does not run at debug, so a scene gate would
  // otherwise suppress every notification on a camera with no line
  // anywhere saying so — indistinguishable from the pipeline being dead.
  if (evaluation.failedCondition === 'scene') host.reportSceneSuppression(rule, subject)
  // A system event the rule IS about, dropped by one of its narrowing
  // filters. Legitimate — and it must not be silent: nine of the eleven
  // kinds on the operator's live rule were dropped this way for four
  // days without one line, and `rule did not match` below is DEBUG on a
  // hub that does not run at debug.
  if (evaluation.excludedBySystemEventFilter !== undefined) {
    host.reportSystemFilterExclusion(rule, subject, evaluation.excludedBySystemEventFilter)
  }
  rejections.push(`${rule.name}:${evaluation.failedCondition ?? 'unknown'}`)
  outcomes.push({
    ruleId: rule.id,
    ruleName: rule.name,
    matched: false,
    ...(evaluation.failedCondition !== undefined
      ? { failedCondition: evaluation.failedCondition }
      : {}),
    cooldown: 'n/a',
    enqueued: 0,
    targetIds: [],
  })
  // The NAMED failing condition — the difference between "the rule is
  // wrong" and "the rule never ran". Without it a silent non-fire is
  // unanswerable (2026-07-30: a permissive probe rule did not fire and
  // there was no line anywhere saying why).
  host.logger.debug('rule did not match', {
    tags: { deviceId: subject.deviceId },
    meta: {
      ruleId: rule.id,
      rule: rule.name,
      kind,
      failed: evaluation.failedCondition,
      classes: subject.classNames,
      // Which way an opening moved — what a `sensorEdge` refusal refused.
      ...(subject.sensorEdge !== undefined ? { sensorEdge: subject.sensorEdge } : {}),
      // Which way a boolean sensor moved — what a `sensorTransition`
      // refusal refused (D640).
      ...(subject.sensorRaised !== undefined ? { sensorRaised: subject.sensorRaised } : {}),
      // The OTHER device ids a device scope reads (D641): a sensor row is
      // included or excluded by the sensor as much as by its camera, and
      // `deviceId` alone cannot say which one a `devices`/`devicesExclude`
      // refusal was about.
      ...(subject.sourceDeviceId !== undefined ? { sourceDeviceId: subject.sourceDeviceId } : {}),
      ...(subject.linkedSensorId !== undefined ? { linkedSensorId: subject.linkedSensorId } : {}),
      // Provenance: which detection this verdict was about. Without it,
      // answering "why did I not get a notification for THAT event?"
      // means correlating timestamps by hand.
      eventId: subject.recordId,
      ...(subject.trackId !== undefined ? { trackId: subject.trackId } : {}),
    },
  })
}
