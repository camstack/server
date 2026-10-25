/**
 * Extracted from NotificationCenter (reconcile, drainTick, deliverDueDigests, createSnooze, snoozeDecision, snoozeGate, recordSnoozeSuppression, cancelSnooze, releaseCooldown, seedCooldowns, hydrateNotifiedTracks, readBootRecentRows).
 * The class method forwards private state through {@link DrainSnoozeHost}.
 */

import { shouldReleaseCooldown } from './confirm-policy.js'
import type { NcCooldownRelease, NcSnoozeGateInput } from './dispatcher.js'
import { NcDispatcher } from './dispatcher.js'
import type { NcIncomingEvent } from './event-intake.js'
import { asReconcile, incomingFromObjectEvent, incomingFromPackageEvent } from './event-intake.js'
import { NcGroupedDelivery } from './grouped/grouped-delivery.js'
import { memberAbsorbedIds, readOutboxGroup } from './grouped/grouped-payload.js'
import { NC_NOTIFIED_TRACK_TTL_MS, NcNotifiedTracks } from './grouped/notified-tracks.js'
import { packagePhaseOf } from './live-intake.js'
import type { NcOutboxEntry, NcOutboxRecordKind } from './outbox.js'
import { NcOutbox } from './outbox.js'
import type { NcRuleSubject, NcSubjectKind } from './rule-engine.js'
import { NC_SYSTEM_DEVICE_ID, cooldownKey } from './rule-engine.js'
import { NcRuleStore } from './rule-store.js'
import type { NcSnoozeCaller } from './rules-provider.js'
import { buildSnoozeDigest, digestTargets } from './snooze-digest.js'
import { canSetGlobal } from './snooze-policy.js'
import { NcSnoozeStore } from './snooze-store.js'
import type { NcSnoozeVerdict, NcSnoozeVerdictSuppressed } from './snooze-verdict.js'
import { snoozeCoverage, snoozeVerdict } from './snooze-verdict.js'
import { NcTextCatalog } from './text-catalog.js'
import type { IScopedLogger, NcSnooze, NcSnoozeInput } from '@camstack/types'
import { setTimeout as sleep } from 'node:timers/promises'
import type { NotificationCenterDeps } from './index.js'

export const DEFAULT_RECONCILE_WINDOW_MS = 15 * 60_000
/** Overlap subtracted from the watermark on boot (idempotent, cheap). */
export const RECONCILE_OVERLAP_MS = 60_000
export const RECONCILE_SCAN_LIMIT = 2_000
/** Watermark persisted every N drain ticks while evaluation is live. */
export const WATERMARK_EVERY_TICKS = 15
/**
 * The boot's recent-rows read (D692 C9, review T10): the cooldown reseed's horizon (the
 * longest cooldown), shared with the notified-set hydration — ONE read.
 */
export const NC_BOOT_RECENT_ROWS_MS = 86_400_000
/** Bounded retry of that read inside the `outbox` phase (review T10 LOW-1) — never a loop. */
export const NC_BOOT_RECENT_ROWS_ATTEMPTS = 3
export const NC_BOOT_RECENT_ROWS_RETRY_MS = 250
/**
 * The subject kind a persisted record kind maps to.
 *
 * `NcOutboxRecordKind` carries two kinds a rule subject never has —
 * `timelapse` and `ai-summary` are SCHEDULE boundaries, not records. They are
 * mapped to `device-event`, which is class-agnostic in `cooldownKey`, so their
 * key is the one the seeder already built for them. A switch rather than a
 * cast: a kind added to either union has to be answered for here.
 */
export function cooldownSubjectKind(kind: NcOutboxRecordKind): NcSubjectKind {
  switch (kind) {
    case 'timelapse':
    case 'ai-summary':
    case 'calendar-events':
      return 'device-event'
    default:
      return kind
  }
}
/**
 * A persisted outbox row, reduced to exactly what `cooldownKey` reads.
 *
 * The point is that it reads NOTHING else: the boot-time cooldown reseed calls
 * the same builder the live path does, so the two can never address different
 * windows. Only the four fields the key is a function of are reconstructed —
 * the class (for `per-class` and audio), the subject kind (which decides
 * whether the class is keyed at all — audio always, occupancy and detections
 * unless `shared`), the system event (subject +
 * direction) and the device.
 */
export function cooldownSubjectFromOutbox(entry: NcOutboxEntry): NcRuleSubject {
  const subject = entry.payload.subject
  return {
    // An occupancy row is PERSISTED as `device-event` (the delivery it rides)
    // but was keyed LIVE as `occupancy-event`, a class-bearing kind. Only an
    // occupancy row freezes `subject.occupancy`, so that is what tells the two
    // apart — rebuilding it as a plain `device-event` dropped the `:c:<class>`
    // tail and lost every occupancy window on each respawn.
    kind:
      entry.recordKind === 'device-event' && subject.occupancy !== undefined
        ? 'occupancy-event'
        : cooldownSubjectKind(entry.recordKind),
    recordId: entry.recordId,
    deviceId: entry.deviceId,
    timestamp: subject.timestamp,
    classNames: subject.className.length > 0 ? [subject.className] : [],
    zones: [...subject.zones],
    ...(subject.systemEvent !== undefined ? { systemEvent: subject.systemEvent } : {}),
  }
}
/** One notified member a persisted row names, as the boot hydration adds it (D692 C9). */
export interface NcHydratedTrack {
  readonly ruleId: string
  /** The survivor first, then the ids it absorbed in the window. */
  readonly trackIds: readonly string[]
  readonly survivorId: string
  readonly at: number
}
/**
 * The notified members one persisted row names: a grouped row's members with their absorbed
 * ids (review T10 MEDIUM-1), else a plain object-event row's subject track.
 */
export function notifiedMembersOf(entry: NcOutboxEntry): readonly NcHydratedTrack[] {
  // Only a grouped DETECTION row is a window a replay could re-open; an alarm row's
  // group (D705) is the incident's picture and guards nothing.
  const group =
    entry.recordKind === 'object-event' ? readOutboxGroup(entry.payload.group) : undefined
  if (group !== undefined) {
    return group.members.map((m) => ({
      ruleId: entry.ruleId,
      trackIds: [m.trackId, ...memberAbsorbedIds(m)],
      survivorId: m.trackId,
      at: entry.createdAt,
    }))
  }
  const trackId = entry.payload.subject.trackId
  if (entry.recordKind !== 'object-event' || trackId === undefined) return []
  return [{ ruleId: entry.ruleId, trackIds: [trackId], survivorId: trackId, at: entry.createdAt }]
}
/**
 * Every cooldown subject one persisted row stamped (D692 §3.6). A grouped close stamps one
 * key PER DISTINCT MEMBER CLASS on the primary's subject, so its row reseeds one subject per
 * class — the same `cooldownKey` the close used (D141: one key builder). A legacy D143 row
 * and every plain row reseed the single subject they always did.
 */
export function cooldownSubjectsFromOutbox(entry: NcOutboxEntry): readonly NcRuleSubject[] {
  const base = cooldownSubjectFromOutbox(entry)
  // The per-class stamp is the grouped close's (detection rows); an alarm row's
  // group (D705) stamped the one system-event key its subject always did.
  const group =
    entry.recordKind === 'object-event' ? readOutboxGroup(entry.payload.group) : undefined
  if (group === undefined || group.legacy) return [base]
  const classes = [...new Set(group.members.map((m) => m.className))]
  if (classes.length === 0) return [base]
  return classes.map((className) => ({ ...base, classNames: [className] }))
}

export interface DrainSnoozeHost {
  consumeEvent(event: NcIncomingEvent): void
  deliverDueDigests(): Promise<void>
  readonly deps: NotificationCenterDeps
  readonly dispatcher: NcDispatcher
  drainTicks: number
  readonly evalChain: Promise<void>
  readonly grouped: NcGroupedDelivery
  groupedSweepQueued: boolean
  readonly intakeOpenedAt: number
  readonly lastFiredAt: Map<string, number>
  readonly logger: IScopedLogger
  notifiedHydrated: boolean
  readonly notifiedTracks: NcNotifiedTracks
  readonly now: () => number
  onChain(name: string, run: () => Promise<void>, deviceId: number): Promise<void>
  readonly outbox: NcOutbox
  recordSnoozeSuppression(
    verdict: NcSnoozeVerdictSuppressed,
    input: NcSnoozeGateInput,
  ): Promise<void>
  readonly rules: NcRuleStore
  readonly sequenceActionsOf: (
    sequenceId: string,
  ) => readonly import('@camstack/types').NcRuleAction[] | undefined
  snoozeDecision(input: NcSnoozeGateInput): NcSnoozeVerdict
  readonly snoozes: NcSnoozeStore
  readonly texts: NcTextCatalog
  watermarkAt(now: number): number
}

/**
 * Boot crash-gap reconcile — see the module docstring.
 *
 * **Bounded at BOTH ends.** `since` closes the gap the previous process left;
 * {@link intakeOpenedAt} closes the one this one would otherwise open. The
 * reconcile used to run before the intake existed, so "a record newer than
 * the watermark" and "a record this process has not evaluated" were the same
 * set. They are not any more: the reconcile is a back-fill phase now, and
 * every record persisted since `start()` opened the intake has ALREADY been
 * evaluated in-process — the exact sentence `drainTick` uses to justify
 * advancing the watermark to `now`.
 *
 * Replaying one of those is not merely redundant. The outbox dedup id makes
 * the DELIVERY idempotent, but a rule's `onTrigger` sequence is actuated
 * before the cooldown gate and before any dedup (see `runRuleActions`), so a
 * replay would open the gate, arm the alarm or sound the siren a second time.
 */
export async function reconcile(host: DrainSnoozeHost): Promise<void> {
  const now = host.now()
  const watermark = await host.outbox.getWatermark()
  const windowStart = now - (host.deps.reconcileWindowMs ?? DEFAULT_RECONCILE_WINDOW_MS)
  const since = Math.max(windowStart, (watermark ?? 0) - RECONCILE_OVERLAP_MS)
  const until = host.intakeOpenedAt
  // D692 C5: a replayed event older than the watermark's overlap may join a replaying
  // window, never open one (review T10 HIGH-1b: inside the overlap, the hydration guards).
  // Without the hydration (its read failed) nothing guards the overlap: strict watermark
  // (review T10 LOW-A).
  host.grouped.beginReplay({
    watermark,
    overlapMs: RECONCILE_OVERLAP_MS,
    hydrated: host.notifiedHydrated,
  })
  let scheduled = 0
  try {
    const events = await host.deps.listObjectEventsSince(since, RECONCILE_SCAN_LIMIT)
    if (events.length >= RECONCILE_SCAN_LIMIT) {
      // The store returns the NEWEST rows, so a full page drops the OLDEST — the events of
      // the windows the watermark was held for (review T10 LOW-D).
      host.logger.warn(
        'notification reconcile scan hit its limit — older missed events were not read',
        { meta: { count: events.length, limit: RECONCILE_SCAN_LIMIT, since } },
      )
    }
    const ordered = [...events]
      .filter((e) => e.timestamp < until)
      .sort((a, b) => a.timestamp - b.timestamp)
    for (const event of ordered) {
      // Same serialized chain as the live hooks — reconcile and live
      // evaluations can never interleave around the cooldown map. Package
      // events are `package` object-event rows; route them to the
      // package-event trigger (matching the live detector hook) so an
      // ordinary immediate rule never fires on a parcel delivery.
      const phase = packagePhaseOf(event)
      host.consumeEvent(
        asReconcile(
          phase !== null ? incomingFromPackageEvent(event, phase) : incomingFromObjectEvent(event),
        ),
      )
      scheduled += 1
    }
  } catch (err) {
    host.logger.warn('notification reconcile failed', {
      meta: { error: String(err), scheduled },
    })
  } finally {
    // D692 C5: the replayed grouped windows end their replay on the chain, after the
    // replayed events: due ones close as `replayed`, the rest go live. ALWAYS queued — a
    // scan that threw after scheduling some events must not leave their windows replaying
    // (never closed) and the watermark pinned under them (review T10 LOW-2).
    void host.onChain(
      'grouped-release-replay',
      () => host.grouped.releaseReplay(),
      NC_SYSTEM_DEVICE_ID,
    )
  }
  await host.evalChain
  if (scheduled > 0) {
    host.logger.info('notification reconcile scanned missed events', {
      meta: { since, events: scheduled },
    })
  }
  await host.outbox.setWatermark(host.watermarkAt(now))
}
export async function drainTick(host: DrainSnoozeHost): Promise<void> {
  // Refresh the windows BEFORE draining: a snooze opened on the hub has to
  // reach the evaluating node, and a rule-reload interval (30 s) of
  // notifications arriving after the operator pressed "snooze 1h" is the
  // feature visibly not working. One tick (2 s) is the bound.
  await host.snoozes.load()
  // D692: the grouped windows' deadlines and floors. APPENDED to the chain, never run
  // inline (C13): a close racing an admission off the chain could deliver twice. ONE
  // sweep waits on the chain at a time (review T8 L-3): a stalled chain must not collect
  // a sweep per tick.
  if (!host.groupedSweepQueued) {
    host.groupedSweepQueued = true
    void host.onChain(
      'grouped-sweep',
      () => {
        host.groupedSweepQueued = false
        return host.grouped.sweep(host.now())
      },
      NC_SYSTEM_DEVICE_ID,
    )
  }
  // Held recorded cuts carry clip bytes: drop the aged ones on the tick,
  // not only when the next recorded row happens to arrive (re-review R4).
  host.dispatcher.sweepRecordedCuts(host.now())
  await host.outbox.drainOnce()
  await host.deliverDueDigests()
  host.drainTicks += 1
  if (host.drainTicks % WATERMARK_EVERY_TICKS === 0) {
    // Evaluation is in-process with the persist hooks: while this node
    // is alive every persisted record has been evaluated, so advancing
    // the watermark to "now" is correct and bounds the boot re-scan — except past an
    // open grouped window, which the watermark must never pass (D692 §5).
    await host.outbox.setWatermark(host.watermarkAt(host.now()))
    await host.snoozes.prune(host.now())
  }
}
/**
 * Send the summary owed by every window that has closed since the last tick.
 *
 * The digest goes exactly where the silenced notifications would have gone —
 * one per target that was actually suppressed — so it needs no routing of its
 * own and can never reach someone the snooze never touched.
 */
export async function deliverDueDigests(host: DrainSnoozeHost): Promise<void> {
  const due = host.snoozes.dueDigests(host.now())
  for (const snooze of due) {
    try {
      const rows = await host.snoozes.suppressedFor(snooze.id)
      const names = await host.dispatcher.resolveDeviceNames(rows.map((r) => r.deviceId))
      for (const targetId of digestTargets(rows)) {
        const mine = rows.filter((r) => r.targetId === targetId)
        const digest = buildSnoozeDigest(host.texts, snooze, mine, names)
        // Null = the window hid nothing for this target; "0 notifications
        // hidden" is a notification nobody asked for.
        if (digest === null) continue
        await host.dispatcher.deliverDigest({
          snoozeId: snooze.id,
          targetId,
          title: digest.title,
          body: digest.body,
          total: digest.total,
        })
      }
      // Marked after the ATTEMPT — see `deliverDigest`. A digest retried every
      // two seconds for six hours is worse than one missed with a log line.
      await host.snoozes.markDigestSent(snooze.id)
    } catch (err) {
      host.logger.warn('snooze digest tick failed', {
        meta: { snoozeId: snooze.id, error: String(err) },
      })
    }
  }
}
/**
 * Open a window on behalf of a caller, with the permission check that makes
 * `global` safe. Lives here rather than in the store because it needs the
 * RULE (its `snoozeAllowGlobal` opt-in), and a permission decision that can
 * silence other people belongs where both halves are visible.
 */
export async function createSnooze(
  host: DrainSnoozeHost,
  input: NcSnoozeInput,
  caller: NcSnoozeCaller,
): Promise<NcSnooze> {
  if (input.scope === 'rule' && input.ruleId === undefined) {
    throw new Error('a rule snooze needs a ruleId')
  }
  if (input.scope === 'device' && input.deviceId === undefined) {
    throw new Error('a camera snooze needs a deviceId')
  }
  const wantsGlobal = input.global === true
  if (wantsGlobal) {
    const rule = input.ruleId !== undefined ? host.rules.get(input.ruleId) : null
    const allowed = canSetGlobal({
      scope: input.scope,
      ...(rule !== null ? { ruleAllowsGlobal: rule.snoozeAllowGlobal === true } : {}),
      isAdmin: caller.isAdmin,
    })
    // Rejected, never silently downgraded to personal: an operator who
    // believes the household is silent and is not has the same problem as one
    // who cannot end a silence.
    if (!allowed) throw new Error('forbidden: this snooze may not be made global')
  }
  const snooze = await host.snoozes.create({
    userId: caller.userId,
    scope: input.scope,
    ...(input.ruleId !== undefined ? { ruleId: input.ruleId } : {}),
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    // Absent = every class, which is what every window authored before the
    // field means and still means.
    ...(input.classes !== undefined && input.classes.length > 0 ? { classes: input.classes } : {}),
    durationMinutes: input.durationMinutes,
    global: wantsGlobal,
    // Absent = ON. Resolved HERE to a concrete boolean rather than by a Zod
    // default, which does not run on the addon cap path.
    summary: input.summary !== false,
  })
  host.logger.info('snooze opened', {
    ...(snooze.deviceId !== undefined ? { tags: { deviceId: snooze.deviceId } } : {}),
    meta: {
      snoozeId: snooze.id,
      scope: snooze.scope,
      by: caller.userId,
      global: snooze.global,
      minutes: input.durationMinutes,
      classes: snooze.classes ?? null,
      ...(snooze.ruleId !== undefined ? { ruleId: snooze.ruleId } : {}),
    },
  })
  return snooze
}
/**
 * THE snooze decision of one delivery — the send gate and the grouped close (D692 C4)
 * both ask it, so "snoozed at close" is exactly what would have silenced the instant
 * notification. The decision itself is `snoozeVerdict`; this adds only the line an alarm
 * rule's exemption owes.
 */
export function snoozeDecision(host: DrainSnoozeHost, input: NcSnoozeGateInput): NcSnoozeVerdict {
  const verdict = snoozeVerdict(input, {
    activeFor: (query) => host.snoozes.activeFor(query),
    ruleFor: (ruleId) => host.rules.get(ruleId),
    sequenceActionsOf: host.sequenceActionsOf,
  })
  if (verdict.kind === 'exempt') {
    // An ALARM rule is never silenced, whatever window covers it. The button
    // surface already refuses to offer one (`buildSnoozeButtons`), but a
    // window opened from the app — a camera window, a whole-feed window — knows
    // nothing about which rules it will meet, so the refusal has to be HERE
    // too. Reported, per camera: a non-suppression that nobody can see is
    // indistinguishable from a gate that is not working.
    host.logger.info('snooze does not apply — alarm rules are never silenced', {
      tags: { deviceId: input.deviceId },
      meta: {
        snoozeId: verdict.snooze.id,
        ruleId: input.ruleId,
        rule: input.ruleName,
        targetId: input.targetId,
        class: input.className ?? null,
      },
    })
  }
  return verdict
}
/**
 * The dispatcher's gate: is this delivery silenced, and if so, count it.
 *
 * Returns the window's id (the dispatcher logs it) or null. Recording is
 * awaited rather than fired off so a suppression cannot be lost to a shutdown
 * between the decision and the row — an under-reported digest is the one
 * failure of this feature the operator cannot detect.
 */
export async function snoozeGate(
  host: DrainSnoozeHost,
  input: NcSnoozeGateInput,
): Promise<string | null> {
  // A grouped row carries every member class (`classNames`): it is silenced only when
  // EVERY class is, exactly as the grouped close judged it (D692 C4, review T9a M-2).
  const suppressed = snoozeCoverage(input, (single) => host.snoozeDecision(single))
  if (suppressed === null) return null
  const recorded = new Set<string>()
  for (const { input: single, verdict } of suppressed) {
    if (recorded.has(verdict.snooze.id)) continue
    recorded.add(verdict.snooze.id)
    await host.recordSnoozeSuppression(verdict, single)
  }
  return suppressed[0]?.verdict.snooze.id ?? null
}
/**
 * Count a suppression for the window's digest. Awaited rather than fired off so a
 * suppression cannot be lost to a shutdown between the decision and the row — an
 * under-reported digest is the one failure of this feature the operator cannot detect.
 */
export async function recordSnoozeSuppression(
  host: DrainSnoozeHost,
  verdict: NcSnoozeVerdictSuppressed,
  input: NcSnoozeGateInput,
): Promise<void> {
  if (!verdict.snooze.summary) return
  await host.snoozes.recordSuppressed({
    snoozeId: verdict.snooze.id,
    targetId: input.targetId,
    ruleId: input.ruleId,
    ruleName: input.ruleName,
    deviceId: input.deviceId,
    at: input.at,
  })
}
/** End a window early. A user may end their own; an admin may end any. */
export async function cancelSnooze(
  host: DrainSnoozeHost,
  snoozeId: string,
  caller: NcSnoozeCaller,
): Promise<void> {
  const existing = host.snoozes.get(snoozeId)
  if (existing === null) throw new Error(`snooze not found: ${snoozeId}`)
  if (!caller.isAdmin && existing.userId !== caller.userId) {
    throw new Error(`forbidden: snooze not owned: ${snoozeId}`)
  }
  await host.snoozes.cancel(snoozeId)
  host.logger.info('snooze cancelled', { meta: { snoozeId, by: caller.userId } })
}
/**
 * Give back a cooldown window whose notification was suppressed after the
 * fact (today: the AI confirm gate).
 *
 * The `at` check is the whole safety of this: the map is keyed per rule and
 * scope, so between the enqueue and the verdict a LATER subject may have
 * fired the same key. Deleting blindly would hand that later fire's window
 * away too, and the next event would arrive as if nothing had ever fired —
 * defeating the cooldown rather than rolling one back. Only the window this
 * exact fire opened is released.
 */
export function releaseCooldown(host: DrainSnoozeHost, input: NcCooldownRelease): void {
  if (!shouldReleaseCooldown(host.lastFiredAt.get(input.key), input.at)) {
    host.logger.debug('cooldown NOT released — a later fire owns this window', {
      tags: { deviceId: input.deviceId },
      meta: { ruleId: input.ruleId, key: input.key },
    })
    return
  }
  host.lastFiredAt.delete(input.key)
  host.logger.info('cooldown released — the suppressed fire gives its window back', {
    tags: { deviceId: input.deviceId },
    meta: { ruleId: input.ruleId, key: input.key },
  })
}
/**
 * Rebuild the cooldown map from persisted outbox rows (restart-proof).
 *
 * The key comes from `cooldownKey` and NOWHERE else. This method used to
 * build the string itself, and the copy had drifted: it knew the
 * `r:<id>` / `r:<id>:d:<device>` shapes and neither the `:c:<class>` tail
 * (`granularity: 'per-class'`, and unconditional for audio) nor — after
 * 2026-08-14 — the `:k:<kind>` one. Every window it could not address was a
 * window that did not survive a restart, so a per-class or audio rule
 * re-fired immediately after every respawn despite the schema promising
 * otherwise. `notifications.md` had carried it as a known defect since
 * 2026-08-02 with the instruction "if you touch `cooldownKey`, fix the seeder
 * in the same commit"; this is that commit.
 *
 * It reads the boot's shared recent-rows read; a read that FAILED is said (review T10
 * LOW-1) — cooldowns then start cold, which is the direction of the doubt.
 */
export function seedCooldowns(host: DrainSnoozeHost, rows: readonly NcOutboxEntry[] | null): void {
  if (rows === null) {
    host.logger.warn(
      'cooldown reseed failed — the outbox could not be read; cooldowns start cold',
      { meta: { horizonMs: NC_BOOT_RECENT_ROWS_MS, attempts: NC_BOOT_RECENT_ROWS_ATTEMPTS } },
    )
    return
  }
  for (const entry of rows) {
    const rule = host.rules.get(entry.ruleId)
    if (rule === null) continue
    for (const subject of cooldownSubjectsFromOutbox(entry)) {
      const key = cooldownKey(rule, subject)
      const prev = host.lastFiredAt.get(key) ?? 0
      if (entry.createdAt > prev) host.lastFiredAt.set(key, entry.createdAt)
    }
  }
}
/**
 * THE EXACTLY-ONCE GUARD OF A GROUPED WINDOW AFTER A CRASH (D692 C9).
 *
 * Re-fills the notified set (`notifiedTracks`) from the boot's recent outbox rows. It
 * runs in the `outbox` back-fill phase, BEFORE the reconcile, so a replayed member whose
 * row a previous process already wrote is refused `already-notified` — whatever window
 * key the replay gives it. The outbox dedup id (`outboxEntryId`, `dedupRef = windowKey`,
 * D694) is only the second line: a fusion between the open and the crash, or a replay
 * that misses the window's first event, re-keys the window and the id no longer matches.
 *
 *  - a grouped row (v2, or a legacy D143 row still on disk): every member's track, and
 *    the ids its survivor absorbed in the window (review T10 MEDIUM-1);
 *  - a plain object-event row: its subject's track (a rule switched from plain to
 *    grouped mid-track must not notify it again);
 *  - a tester row never: the tester's group of one is never in the notified set (C11).
 *
 * A row of the last {@link NC_NOTIFIED_TRACK_TTL_MS} is stamped with its `createdAt`. An
 * OLDER row (up to the 24 h read) is carried too, stamped NOW (review T10 MEDIUM-A): a
 * track still in view had its TTL slid by every refusal, and a respawn must not forget
 * that. Whether the track has closed is not asked — nothing can answer it at boot.
 *
 * A read that FAILS is said and hydrates nothing (D393): the guard falls back to the
 * dedup id, and a WARN says so — never an empty set that looks like "nothing was sent".
 * It also records that the set is NOT hydrated, so the replay runs on the strict
 * watermark (review T10 LOW-A): the overlap is safe only with the hydration behind it.
 */
export async function hydrateNotifiedTracks(
  host: DrainSnoozeHost,
  rows: readonly NcOutboxEntry[] | null,
): Promise<void> {
  host.notifiedHydrated = rows !== null
  if (rows === null) {
    host.logger.warn(
      'grouped notified-track hydration failed — a replayed window is guarded by the dedup id only',
      { meta: { ttlMs: NC_NOTIFIED_TRACK_TTL_MS, attempts: NC_BOOT_RECENT_ROWS_ATTEMPTS } },
    )
    return
  }
  const now = host.now()
  const horizon = now - NC_NOTIFIED_TRACK_TTL_MS
  const recent: NcHydratedTrack[] = []
  const older = new Map<string, NcHydratedTrack>()
  for (const entry of rows) {
    if (entry.payload.synthetic === true) continue
    for (const member of notifiedMembersOf(entry)) {
      if (entry.createdAt >= horizon) {
        recent.push(member)
        continue
      }
      const key = `${member.ruleId}|${member.survivorId}`
      const seen = older.get(key)
      if (seen === undefined || seen.at < member.at) older.set(key, member)
    }
  }
  // Every older survivor is carried for one TTL from NOW (review T10 MEDIUM-A). No track
  // store is asked whether it closed: `listRecentTracks` is clamped to 1 000 rows in
  // production and answers for closed tracks only, so a filter on it filtered nothing. A
  // track id is never reused, so one that ended costs one entry for 30 minutes.
  const carried = [...older.values()].map((m) => ({ ...m, at: now }))
  // The set prunes in stamp order: add oldest first.
  const adds = [...recent, ...carried].toSorted((a, b) => a.at - b.at)
  for (const add of adds) host.notifiedTracks.add(add.ruleId, add.trackIds, add.at, add.survivorId)
  host.logger.info('grouped notified tracks hydrated from the outbox', {
    meta: {
      rows: rows.length,
      tracks: recent.reduce((n, m) => n + m.trackIds.length, 0),
      carried: carried.reduce((n, m) => n + m.trackIds.length, 0),
      ttlMs: NC_NOTIFIED_TRACK_TTL_MS,
      horizonMs: NC_BOOT_RECENT_ROWS_MS,
    },
  })
}
/**
 * The boot's ONE recent-rows read ({@link NC_BOOT_RECENT_ROWS_MS}): the notified-set
 * hydration and the cooldown reseed both read it. A read that FAILS is retried a bounded
 * number of times inside the `outbox` phase (review T10 LOW-1), then is `null` — never
 * an empty list that reads as "nothing was sent" (D393).
 */
export async function readBootRecentRows(
  host: DrainSnoozeHost,
): Promise<readonly NcOutboxEntry[] | null> {
  for (let attempt = 1; ; attempt += 1) {
    const rows = await host.outbox.tryQueryRecentPersisted(host.now() - NC_BOOT_RECENT_ROWS_MS)
    if (rows !== null) return rows
    if (attempt >= NC_BOOT_RECENT_ROWS_ATTEMPTS) return null
    host.logger.info('outbox recent rows read failed at boot — retrying', {
      meta: { attempt, attempts: NC_BOOT_RECENT_ROWS_ATTEMPTS },
    })
    await sleep(NC_BOOT_RECENT_ROWS_RETRY_MS * attempt)
  }
}
