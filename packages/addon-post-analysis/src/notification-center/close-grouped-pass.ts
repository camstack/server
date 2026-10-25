/**
 * Extracted from NotificationCenter (closeGroupedPass, snoozedAtClose, judgeDropped, sealGroupedWindow, closeGroupedWindow, memberFates).
 * The class method forwards private state through {@link CloseGroupedPassHost}.
 */

import type { NcAlarmMatchPhase, NcAlarmPushVerdict } from './alarm/alarm-push-policy.js'
import { intrusionDeviceOf } from './alarm/alarm-push-policy.js'
import type { NcSnoozeGateInput } from './dispatcher.js'
import { NcDispatcher } from './dispatcher.js'
import type { NcBuildEntriesExtras } from './evaluate-and-enqueue.js'
import type { NcEventOrigin } from './event-intake.js'
import type { NcGroupedFate } from './grouped/grouped-close-pass.js'
import { groupedClosePass, isJudgedReason } from './grouped/grouped-close-pass.js'
import { NcGroupedDelivery } from './grouped/grouped-delivery.js'
import type { NcGroupOrderInput, NcOutboxGroupV2 } from './grouped/grouped-payload.js'
import {
  NC_OUTBOX_GROUP_ABSORBED_MAX,
  boundAbsorbedIds,
  orderGroupMembers,
} from './grouped/grouped-payload.js'
import type {
  NcGroupedCloseReason,
  NcGroupedMember,
  NcGroupedWindow,
} from './grouped/grouped-window-buffer.js'
import { withLabelOverlay } from './grouped/grouped-window-buffer.js'
import type {
  NcGroupMemberFate,
  NcGroupMemberRecord,
  NcGroupOutcome,
} from './grouped/nc-group-store.js'
import { NcGroupStore } from './grouped/nc-group-store.js'
import { NcJudgedTracks, NcNotifiedTracks } from './grouped/notified-tracks.js'
import type { NcCooldownStamp, NcOutboxAlarmIntrusion, NcOutboxEnqueueInput } from './outbox.js'
import { NcOutbox } from './outbox.js'
import type { NcEvaluation, NcRuleSubject, NcSubjectKind } from './rule-engine.js'
import { cooldownKey } from './rule-engine.js'
import { NcRuleStore } from './rule-store.js'
import type { NcSnoozeVerdict, NcSnoozeVerdictSuppressed } from './snooze-verdict.js'
import { snoozeCoverage } from './snooze-verdict.js'
import type { IScopedLogger, NcRule, NcRuleTarget, NcSnooze } from '@camstack/types'

/** The snoozes that cover one target of a grouped close, every member class (C4). */
export interface NcGroupedSnoozeCover {
  readonly snoozes: readonly NcSnooze[]
}
/**
 * One KEPT member as the payload freezes it (§6.1): its latest name, its own first-matched
 * event identity (D694 — the event's STORED timestamp, never a clock), its qualifying
 * instant, the rule's zone ids and its full-match `matchedOn`.
 */
export function groupOrderInput(
  fate: NcGroupedFate,
  triggerZoneIds: readonly string[] | undefined,
): NcGroupOrderInput {
  const member = fate.member
  const frozen = member.firstMatchedSubject ?? member.subject
  const labelKind = member.subject.labelKind
  const absorbed = boundAbsorbedIds(member.absorbedIds).kept
  return {
    trackId: member.trackId,
    className: member.className,
    ...(member.subject.label !== undefined ? { label: member.subject.label } : {}),
    ...(labelKind === 'identity' || labelKind === 'plate' ? { labelKind } : {}),
    eventId: frozen.recordId,
    eventDeviceId: frozen.deviceId,
    eventAt: frozen.timestamp,
    triggerAt: member.firstMatchedAt ?? member.subject.timestamp,
    ...(triggerZoneIds !== undefined ? { triggerZoneIds } : {}),
    ...(fate.matchedOn !== undefined ? { matchedOn: fate.matchedOn } : {}),
    ...(absorbed.length > 0 ? { absorbedIds: absorbed } : {}),
    firstSeenAt: member.firstSeenAt,
  }
}
export function ruleCropZoneIds(rule: NcRule): readonly string[] | undefined {
  // ZONE CROP for an occupancy rule. Occupancy scopes its zone INSIDE the
  // condition (`occupancy.zoneId`) rather than in `conditions.zones`, so a
  // `zoneCrop` rule counting cars in one bay used to ship the whole scene —
  // and then hand the whole scene to the confirm gate, which is exactly the
  // picture that makes "how many cars are in the bay" unanswerable.
  if (rule.conditions.zones !== undefined) return rule.conditions.zones.ids
  const zoneId = rule.conditions.occupancy?.zoneId
  return zoneId !== undefined ? [zoneId] : undefined
}
/** What one grouped close decided — the window record's SEAL (spec §5). */
export interface NcGroupedCloseResult {
  readonly closedAt: number
  readonly outcome: NcGroupOutcome
  readonly members: readonly NcGroupMemberRecord[]
  /** Rows the close inserted into the outbox (0 on every path that sends nothing). */
  readonly enqueued: number
}

export interface CloseGroupedPassHost {
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
  closeGroupedPass(
    window: NcGroupedWindow,
    reason: NcGroupedCloseReason,
  ): Promise<NcGroupedCloseResult>
  readonly dispatcher: NcDispatcher
  evaluateGrouped(rule: NcRule, subject: NcRuleSubject, relax: boolean): NcEvaluation
  readonly groupStore: NcGroupStore
  readonly grouped: NcGroupedDelivery
  groupedAlarmPhaseOf(ruleId: string, member: NcGroupedMember): NcAlarmMatchPhase
  intrusionLocationsOf(deviceIds: readonly number[]): readonly string[]
  judgeDropped(
    rule: NcRule,
    window: NcGroupedWindow,
    dropped: readonly NcGroupedFate[],
    at: number,
  ): void
  readonly judgedTracks: NcJudgedTracks
  readonly lastFiredAt: Map<string, number>
  readonly logger: IScopedLogger
  memberFates(
    fates: readonly NcGroupedFate[],
    keptFate: NcGroupMemberFate,
  ): readonly NcGroupMemberRecord[]
  mutedAuthority(subject: NcRuleSubject): number | undefined
  readonly notifiedTracks: NcNotifiedTracks
  readonly now: () => number
  readonly outbox: NcOutbox
  recordSnoozeSuppression(
    verdict: NcSnoozeVerdictSuppressed,
    input: NcSnoozeGateInput,
  ): Promise<void>
  resolveUserTargets(rule: NcRule, deviceId: number): Promise<readonly NcRuleTarget[]>
  readonly rules: NcRuleStore
  sealGroupedWindow(
    window: NcGroupedWindow,
    reason: NcGroupedCloseReason,
    result: NcGroupedCloseResult,
  ): void
  snoozeDecision(input: NcSnoozeGateInput): NcSnoozeVerdict
  snoozedAtClose(
    rule: NcRule,
    windowKey: string,
    entries: readonly NcOutboxEnqueueInput[],
    classes: readonly string[],
    at: number,
  ): Promise<ReadonlyMap<string, NcGroupedSnoozeCover>>
}

export async function closeGroupedPass(
  host: CloseGroupedPassHost,
  window: NcGroupedWindow,
  reason: NcGroupedCloseReason,
): Promise<NcGroupedCloseResult> {
  const closedAt = host.now()
  const rule = host.rules.get(window.ruleId)
  const tags = { deviceId: window.deviceId }
  const base = {
    ruleId: window.ruleId,
    ...(rule !== null ? { rule: rule.name } : {}),
    windowKey: window.key,
    closeReason: reason,
  }
  if (rule === null || !rule.enabled) {
    host.logger.info('grouped window closed with NO notification', {
      tags,
      meta: {
        ...base,
        reason: rule === null ? 'rule-removed' : 'rule-disabled',
        members: window.members.map((m) => m.trackId),
      },
    })
    return {
      closedAt,
      outcome: 'dropped',
      members: window.members.map((m) => ({
        trackId: m.trackId,
        className: m.className,
        fate: rule === null ? 'rule-removed' : 'rule-disabled',
      })),
      enqueued: 0,
    }
  }
  const fates = groupedClosePass({
    rule,
    window,
    evaluateFull: (subject) => host.evaluateGrouped(rule, subject, false),
    notified: (trackId) => host.notifiedTracks.has(rule.id, trackId),
    awaitingOf: (member) => {
      const finality = host.grouped.finalityOf(window, member)
      return finality.final ? undefined : finality.awaiting
    },
    // D706: the same policy the plain path applies at the match, on the phase each member
    // matched under; a suppressed member is dropped below with its reason, on its camera.
    alarmVerdictOf: (member) =>
      host.alarmPushVerdict(rule, window.deviceId, host.groupedAlarmPhaseOf(rule.id, member)),
  })
  const dropped = fates.filter((f) => !f.kept)
  for (const fate of dropped) {
    host.logger.info(`grouped member dropped — ${fate.reason ?? 'unknown'}`, {
      // The MEMBER's camera: a rule-scope window (D706) holds several.
      tags: { deviceId: fate.member.subject.deviceId },
      meta: {
        ...base,
        trackId: fate.member.trackId,
        className: fate.member.className,
        ...(fate.awaiting !== undefined ? { awaiting: fate.awaiting } : {}),
      },
    })
  }
  const droppedList = dropped.map((f) => ({
    trackId: f.member.trackId,
    reason: f.reason ?? 'unknown',
  }))
  const kept = fates.filter((f) => f.kept)
  if (kept.length === 0) {
    host.logger.info('grouped window closed with NO notification', {
      tags,
      meta: { ...base, reason: 'every-member-dropped', dropped: droppedList },
    })
    host.judgeDropped(rule, window, dropped, closedAt)
    return {
      closedAt,
      outcome: 'dropped',
      members: host.memberFates(fates, 'sent'),
      enqueued: 0,
    }
  }

  const cropZoneIds = ruleCropZoneIds(rule)
  for (const fate of kept) {
    // Review T10 MEDIUM-1: the row carries a bounded set of absorbed ids; what the bound
    // leaves out is said (D391), since a crash could re-notify under one of those ids.
    const { dropped: unstored } = boundAbsorbedIds(fate.member.absorbedIds)
    if (unstored.length === 0) continue
    host.logger.info('grouped notification: absorbed ids past the bound not written on the row', {
      tags,
      meta: {
        ...base,
        trackId: fate.member.trackId,
        unstored,
        max: NC_OUTBOX_GROUP_ABSORBED_MAX,
      },
    })
  }
  const ordered = orderGroupMembers(kept.map((f) => groupOrderInput(f, cropZoneIds)))
  const primary = kept.find((f) => f.member.trackId === ordered[0]?.trackId) ?? kept[0]
  if (primary === undefined) {
    return {
      closedAt,
      outcome: 'dropped',
      members: host.memberFates(fates, 'close-failed'),
      enqueued: 0,
    }
  }
  // C12: the primary's FIRST-matched moment, with the best name learned since (C1).
  const primarySubject: NcRuleSubject = {
    ...withLabelOverlay(
      primary.member.firstMatchedSubject ?? primary.member.subject,
      primary.member.overlay,
    ),
    trackId: primary.member.trackId,
  }

  const mutedBy = host.mutedAuthority(primarySubject)
  if (mutedBy !== undefined && !window.flags.bypassMute) {
    host.logger.info('grouped window closed with NO notification', {
      tags,
      meta: { ...base, reason: 'muted', mutedDeviceId: mutedBy, dropped: droppedList },
    })
    return {
      closedAt,
      outcome: 'dropped',
      members: host.memberFates(fates, 'muted'),
      enqueued: 0,
    }
  }

  const classes = [...new Set(ordered.map((m) => m.className))]
  const stamps: readonly NcCooldownStamp[] = classes.map((className) => ({
    key: cooldownKey(rule, { ...primarySubject, classNames: [className] }),
    at: closedAt,
  }))
  const groupV2: NcOutboxGroupV2 = {
    version: 2,
    key: window.key,
    openedAt: window.openedAt,
    closedAt,
    closeReason: reason,
    members: ordered,
  }
  // D706: a window with a member that matched during an intrusion is titled with the
  // locations of every such member — one grouped push per window, never an alarm row.
  const intruders = kept.filter((f) => f.intrusion === true)
  const alarmIntrusion: NcOutboxAlarmIntrusion | undefined =
    intruders.length > 0
      ? {
          locations: host.intrusionLocationsOf(
            intruders.map((f) => intrusionDeviceOf(f.member.subject)),
          ),
        }
      : undefined
  const userTargets = await host.resolveUserTargets(rule, window.deviceId)
  const entries = host.buildEntries(
    rule,
    primarySubject,
    'object-event',
    primary.matchedOn,
    userTargets,
    window.origin,
    undefined,
    {
      groupV2,
      dedupRef: window.key,
      cooldowns: stamps,
      ...(alarmIntrusion !== undefined ? { alarmIntrusion } : {}),
    },
  )

  if (entries.length === 0) {
    // Review T9a L-1: nobody to tell (a user-only rule whose users resolve to no target).
    // Not "the rows already existed": nothing was ever built.
    host.logger.info('grouped window closed with NO notification', {
      tags,
      meta: { ...base, reason: 'no-target', members: ordered.map((m) => m.trackId) },
    })
    return {
      closedAt,
      outcome: 'dropped',
      members: host.memberFates(fates, 'no-target'),
      enqueued: 0,
    }
  }
  const snoozed = await host.snoozedAtClose(rule, window.key, entries, classes, closedAt)
  const sendable = entries.filter((e) => !snoozed.has(e.targetId))
  if (entries.length > 0 && sendable.length === 0) {
    const covers = [...snoozed.values()].flatMap((c) => c.snoozes)
    host.logger.info('grouped window closed with NO notification', {
      tags,
      meta: {
        ...base,
        reason: 'rule-snoozed-at-close',
        snoozeIds: [...new Set(covers.map((c) => c.id))],
        snoozeScopes: [...new Set(covers.map((c) => c.scope))],
        targets: [...snoozed.entries()].map(([targetId, c]) => ({
          targetId,
          snoozeIds: c.snoozes.map((x) => x.id),
        })),
        members: ordered.map((m) => m.trackId),
        dropped: droppedList,
      },
    })
    return {
      closedAt,
      outcome: 'dropped',
      members: host.memberFates(fates, 'snoozed'),
      enqueued: 0,
    }
  }
  for (const [targetId, cover] of snoozed) {
    host.logger.info('grouped notification: target snoozed at close — no row for it', {
      tags,
      meta: {
        ...base,
        targetId,
        snoozeIds: cover.snoozes.map((c) => c.id),
        snoozeScopes: cover.snoozes.map((c) => c.scope),
      },
    })
  }

  const inserted = await host.outbox.enqueue(sendable)
  // From here on (review T9b L-5): in-memory bookkeeping and one log line, nothing that
  // can throw — the outlook read below is caught in `recognitionOutlookFor`. A throw after
  // the enqueue would seal the record `dropped` over a row that was written.
  // C11: the tester's group of one never enters the ledger a real subject is judged by.
  if (inserted > 0 && window.origin !== 'synthetic') {
    for (const f of kept) {
      host.notifiedTracks.add(rule.id, [f.member.trackId, ...f.member.absorbedIds], closedAt)
    }
  }
  if (inserted > 0 && !window.flags.bypassCooldown) {
    for (const stamp of stamps) host.lastFiredAt.set(stamp.key, stamp.at)
  }
  host.judgeDropped(rule, window, dropped, closedAt)
  const pendingAtClose = window.members.flatMap((m) => {
    const finality = host.grouped.finalityOf(window, m)
    return finality.final ? [] : [{ trackId: m.trackId, awaiting: finality.awaiting }]
  })
  host.logger.info(
    inserted > 0
      ? 'grouped window closed'
      : 'grouped window closed — every row already existed, nothing new enqueued',
    {
      tags,
      meta: {
        ...base,
        members: window.members.length,
        sent: kept.length,
        rows: inserted,
        targetIds: sendable.map((e) => e.targetId),
        dropped: droppedList,
        waitedMs: closedAt - window.openedAt,
        ...(pendingAtClose.length > 0 ? { pendingAtClose } : {}),
      },
    },
  )
  return {
    closedAt,
    outcome: 'sent',
    members: host.memberFates(fates, inserted > 0 ? 'sent' : 'already-existed'),
    enqueued: inserted,
  }
}
/**
 * C4: which targets of a grouped close a snooze covers, asked exactly as the send gate
 * asks it — `snoozeDecision`, with that target's owner — once per member class. A target
 * is covered only when EVERY class is (a class snooze must not silence the dog it was not
 * set for). A covering window with a summary counts the suppression, as the gate does.
 */
export async function snoozedAtClose(
  host: CloseGroupedPassHost,
  rule: NcRule,
  windowKey: string,
  entries: readonly NcOutboxEnqueueInput[],
  classes: readonly string[],
  at: number,
): Promise<ReadonlyMap<string, NcGroupedSnoozeCover>> {
  const covered = new Map<string, NcGroupedSnoozeCover>()
  for (const entry of entries) {
    const owner = await host.dispatcher.snoozeOwnerOf(entry.targetId)
    if (!owner.known) {
      // Unknown owner: only a GLOBAL window can be judged here; the send gate re-asks
      // with the owner it resolves. The direction of the doubt is DELIVERING.
      host.logger.debug(
        'grouped close: target owner unreadable — personal snoozes left to the send gate',
        {
          tags: { deviceId: entry.deviceId },
          meta: {
            ruleId: rule.id,
            rule: rule.name,
            windowKey,
            targetId: entry.targetId,
            reason: owner.reason,
          },
        },
      )
    }
    const ownerUserId = owner.known ? owner.ownerUserId : undefined
    // The ONE judgement of a multi-class delivery (`snoozeCoverage`): the send gate asks
    // the same function with the same classes, so the two cannot disagree.
    const suppressed = snoozeCoverage(
      {
        ruleId: rule.id,
        ruleName: rule.name,
        targetId: entry.targetId,
        deviceId: entry.deviceId,
        ...(ownerUserId !== undefined ? { ownerUserId } : {}),
        classNames: classes,
        at,
      },
      (single) => host.snoozeDecision(single),
    )
    if (suppressed === null) continue
    const snoozes = new Map<string, NcSnooze>()
    for (const { input, verdict } of suppressed) {
      if (snoozes.has(verdict.snooze.id)) continue
      snoozes.set(verdict.snooze.id, verdict.snooze)
      await host.recordSnoozeSuppression(verdict, input)
    }
    covered.set(entry.targetId, { snoozes: [...snoozes.values()] })
  }
  return covered
}
/**
 * C10: a member dropped for the rule's recognition scope is judged for it, with the
 * subject it was judged on. A closed member is not: its track has no later event, and
 * its close already ended any judgement.
 */
export function judgeDropped(
  host: CloseGroupedPassHost,
  rule: NcRule,
  window: NcGroupedWindow,
  dropped: readonly NcGroupedFate[],
  at: number,
): void {
  if (window.origin === 'synthetic') return
  for (const fate of dropped) {
    if (!isJudgedReason(fate.reason) || fate.member.closed) continue
    host.judgedTracks.add({
      ruleId: rule.id,
      deviceId: window.deviceId,
      survivorId: fate.member.trackId,
      trackIds: [fate.member.trackId, ...fate.member.absorbedIds],
      subject: fate.member.subject,
      at,
    })
  }
}
/**
 * Spec §5: SEAL the window's record with what the close decided. Best-effort and never
 * awaited — the store write must not stall the chain; the seal waits for the window's own
 * open write inside the store (L-7).
 */
export function sealGroupedWindow(
  host: CloseGroupedPassHost,
  window: NcGroupedWindow,
  reason: NcGroupedCloseReason,
  result: NcGroupedCloseResult,
): void {
  void host.groupStore.recordSealed(window, {
    closedAt: result.closedAt,
    outcome: result.outcome,
    closeReason: reason,
    members: result.members,
  })
}
/**
 * D692 §3.5: the close pass of one grouped window, handed a window already taken out of
 * the buffer with its members reserved (C13). It runs on the evaluation chain.
 *
 *  1. the rule as it stands NOW (gone or disabled → nothing);
 *  2. the final pass (`groupedClosePass`): every member against the FULL rule; each drop
 *     is said with its reason (D391);
 *  3. no member left → no message, nothing stamped;
 *  4. the mute re-check (C4);
 *  5. the members ordered, the primary's first-matched moment frozen (C12), ONE entry per
 *     target with `dedupRef = windowKey` (D694 builds the id);
 *  6. "snoozed at close" (C4): every entry asks the instant path's `snoozeVerdict`, per
 *     member class, with the owner the send gate would pass. A covered TARGET loses only
 *     its own row; the window is dropped only when EVERY target is covered;
 *  7. the enqueue; on `inserted > 0` the kept tracks become notified and every member
 *     class's cooldown key is stamped at `closedAt` (§3.6).
 *
 * Members dropped for the rule's recognition scope are judged (C10) unless the operator
 * silenced the window (mute, or every target snoozed): those subjects were not judged.
 */
export async function closeGroupedWindow(
  host: CloseGroupedPassHost,
  window: NcGroupedWindow,
  reason: NcGroupedCloseReason,
): Promise<number> {
  let result: NcGroupedCloseResult
  try {
    result = await host.closeGroupedPass(window, reason)
  } catch (err) {
    // The window left the buffer and sent nothing (the caller says so, D391): the record
    // must not stay open forever. A throw can only come BEFORE the enqueue (review T9b
    // L-5: nothing after it can throw), so `dropped` is the truth.
    host.sealGroupedWindow(window, reason, {
      closedAt: host.now(),
      outcome: 'dropped',
      members: window.members.map((m) => ({
        trackId: m.trackId,
        className: m.className,
        fate: 'close-failed',
      })),
      enqueued: 0,
    })
    throw err
  }
  host.sealGroupedWindow(window, reason, result)
  return result.enqueued
}
/** Every member's fate, the kept ones as `keptFate` (they only differ when the window said nothing). */
export function memberFates(
  fates: readonly NcGroupedFate[],
  keptFate: NcGroupMemberFate,
): readonly NcGroupMemberRecord[] {
  return fates.map((f) => ({
    trackId: f.member.trackId,
    className: f.member.className,
    fate: f.kept ? keptFate : (f.reason ?? 'failed-condition:unknown'),
  }))
}
