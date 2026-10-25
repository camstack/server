/**
 * Extracted from NotificationCenter (enqueueStateSummary, reloadTexts, hydrateLiveness, reportLivenessDrop, onDeviceDeleted, removeDeviceData, onAlarmPublish, reportSystemFilterExclusion, reportSceneSuppression).
 * The class method forwards private state through {@link BootHydrationHost}.
 */

import type { DurableKindDeps } from '../durable/durable-wiring.js'
import type { NcPanelGateWords } from './alarm/alarm-gate-words.js'
import { alarmGateWords } from './alarm/alarm-gate-words.js'
import type { NcAlarmPublishReport } from './alarm/alarm-panel-device.js'
import type { NcAlarmTransition } from './alarm/alarm-transitions.js'
import { NcAlertStore } from './alerts/alert-store.js'
import type { NcAlarmPanelPort } from './center-deps.js'
import { NcDeviceDirectory } from './device-directory.js'
import { NcDeletedSubjectPruner } from './device-prune-runner.js'
import { removeNcDeviceRows } from './device-removal.js'
import { NcDeviceStateCache } from './device-state-cache.js'
import type { NcBuildEntriesExtras } from './evaluate-and-enqueue.js'
import type { NcEventOrigin, NcIncomingEvent } from './event-intake.js'
import { discardedLivenessEvent } from './event-intake.js'
import { NcLivenessLedger } from './liveness-ledger.js'
import { OccupancyStore } from './occupancy-store.js'
import type { NcOutboxEnqueueInput } from './outbox.js'
import { NcOutbox } from './outbox.js'
import type { NcRuleSubject, NcSubjectKind, NcSystemEventExcludingFilter } from './rule-engine.js'
import { NcRuleStore } from './rule-store.js'
import { NcSceneStateCache, sceneGateReason } from './scene-state-cache.js'
import { stateSummarySectionOf, withSummaryBody } from './state-summary/state-summary-delivery.js'
import type {
  NcStateSummaryEnqueued,
  NcStateSummaryOrigin,
} from './state-summary/state-summary-service.js'
import { NcStateSummaryService } from './state-summary/state-summary-service.js'
import { NcTextCatalogStore } from './text-catalog-store.js'
import { NcTextCatalog, ncTextSnapshotsEqual } from './text-catalog.js'
import type { IScopedLogger, NcConditions, NcRule, NcRuleTarget } from '@camstack/types'

export interface BootHydrationHost {
  readonly alarmPanel: NcAlarmPanelPort | null
  readonly alertStore: NcAlertStore
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
  readonly deviceDirectory: NcDeviceDirectory
  readonly deviceStates: NcDeviceStateCache
  readonly evaluationActive: boolean
  kindDeps(): DurableKindDeps
  readonly liveness: NcLivenessLedger
  readonly logger: IScopedLogger
  readonly now: () => number
  readonly occupancyStore: OccupancyStore
  readonly outbox: NcOutbox
  panelGateWords: NcPanelGateWords | null
  readonly pruner: NcDeletedSubjectPruner
  resolveUserTargets(rule: NcRule, deviceId: number): Promise<readonly NcRuleTarget[]>
  readonly rules: NcRuleStore
  readonly sceneGateReported: Map<string, string>
  readonly sceneStates: NcSceneStateCache
  scheduleAlarmTransition(panel: NcAlarmPanelPort, transition: NcAlarmTransition): void
  readonly stateSummary: NcStateSummaryService
  readonly textStore: NcTextCatalogStore
  readonly texts: NcTextCatalog
}

/**
 * Enqueue ONE state summary row (D647) through the rule's ordinary rows: its
 * targets, its users (admins only — the row files under the system device),
 * its template, and the drain's snooze gate and retries. The record id is
 * the dedup key, so a window — or each section of it (D698) — is enqueued
 * once whatever the restarts. A TEST's rows carry the `synthetic` origin, so
 * they are marked as a test exactly like every other rule test's.
 */
export async function enqueueStateSummary(
  host: BootHydrationHost,
  rule: NcRule,
  subject: NcRuleSubject,
  origin: NcStateSummaryOrigin,
): Promise<NcStateSummaryEnqueued> {
  // A custom body that names none of the summary's content would send an
  // empty summary: its text is appended instead (review M3).
  const appended = withSummaryBody(rule, stateSummarySectionOf(subject))
  if (appended !== null) {
    host.logger.warn(
      'state summary rule body names no summary content — {{summaryText}} appended',
      {
        meta: { ruleId: rule.id, rule: rule.name },
      },
    )
  }
  const sent = appended ?? rule
  const userTargets = await host.resolveUserTargets(sent, subject.deviceId)
  const entries = host.buildEntries(
    sent,
    subject,
    'system-event',
    ['systemEvent'],
    userTargets,
    origin,
  )
  if (entries.length === 0) {
    // Users reach ADMINS only on a summary row (it spans devices), so a rule
    // addressed only to non-admin users reaches nobody — said, not silent.
    host.logger.warn(
      'state summary reached NO target — its users are not admins, and it has no targets',
      {
        meta: { ruleId: rule.id, rule: rule.name, targetUsers: rule.targetUsers ?? [] },
      },
    )
    return { inserted: 0, targetIds: [] }
  }
  const inserted = await host.outbox.enqueue(entries)
  return { inserted, targetIds: entries.map((entry) => entry.targetId) }
}
/**
 * Re-read the text document and point the shared catalog at it.
 *
 * Never throws: the store's own failure path answers the snapshot it already
 * held (or the shipped English default), so the worst outcome of a settings
 * store that fell over is a notification in the wrong language — never a
 * notification that did not go out.
 */
export async function reloadTexts(host: BootHydrationHost): Promise<void> {
  const before = host.texts.snapshot
  const next = await host.textStore.load()
  host.texts.apply(next)
  // On CHANGE only — including the first load, where `before` is the shipped
  // default. A line every reload tick would be noise; no line at all would
  // make "which language is this hub speaking?" a question with no answer in
  // the logs, and the symptom of getting it wrong (an English notification in
  // an Italian household) is indistinguishable from a misconfigured operator.
  // By VALUE, never by reference: `load()` re-parses the row through zod on
  // every call, so `before.overrides === next.overrides` was false at
  // byte-identical content forever — 58 of these lines in 30 minutes on a hub
  // whose language had not changed (live, 2026-08-25). See
  // `ncTextSnapshotsEqual`.
  if (ncTextSnapshotsEqual(before, next)) return
  host.logger.info('notification texts loaded', {
    meta: {
      language: next.language,
      overriddenKeys: Object.values(next.overrides).reduce(
        (sum, keys) => sum + Object.keys(keys ?? {}).length,
        0,
      ),
    },
  })
}
/**
 * Boot reseed of the durable liveness ledger.
 *
 * The count is said OUT LOUD at info, because it is the one line that
 * distinguishes the two boots: `subjects: 15` is a hub that remembers what
 * its cameras were, and `subjects: 0` is the hub that is about to announce
 * all fifteen of them as if they had just come back. Never throws — the
 * ledger's own failure path keeps whatever is mirrored, and an empty mirror
 * seeds silently (D49: fail toward discard).
 */
export async function hydrateLiveness(host: BootHydrationHost): Promise<void> {
  const subjects = await host.liveness.load()
  // Pre-R1-H1 leftovers: `node:<node>/<child>` offline rows a worker
  // restart wrote under the node kinds. Today's intake never clears them.
  const forgottenWorkers = await host.liveness.forgetWorkerNodeSubjects()
  // …and then from the DIRECTORY, for every device that has never produced a
  // liveness event and therefore has no row of its own. Without this, the
  // first thing such a device ever says is its own death, and the ledger
  // records it instead of announcing it — four cameras were unplugged on
  // 2026-08-13 and two of them were silent. See `seedFromDirectory` for why
  // only the ONLINE ones are seeded and why that cannot re-arm the flood.
  const seeded = host.liveness.seedFromDirectory(host.deviceDirectory.all(), host.now())
  host.logger.info('liveness ledger reseeded', {
    meta: {
      subjects,
      seededFromDirectory: seeded,
      directory: host.deviceDirectory.size(),
      ...(forgottenWorkers > 0 ? { forgottenWorkerNodeSubjects: forgottenWorkers } : {}),
    },
  })
}
/**
 * Say that the ledger refused a liveness event, and why.
 *
 * A seed is INFO and a repeat is DEBUG on purpose: seeding happens once per
 * subject per lifetime of the ledger, and it is exactly what an operator
 * reading the logs after a restart needs to see ("it did not announce
 * them"). A seed heard BEFORE the boot load is provisional (D698): the load
 * keeps the stored row when it holds the same state, and its `boot window
 * settled` line says how many it kept and wrote. A no-flip is ordinary bus
 * chatter — two categories describing one edge — and would be noise at info.
 */
export function reportLivenessDrop(
  host: BootHydrationHost,
  incoming: NcIncomingEvent,
  verdict: 'seeded' | 'no-flip',
): void {
  const dropped = discardedLivenessEvent(incoming, verdict)
  const meta = { category: dropped.category, ...dropped.meta }
  if (verdict === 'seeded') {
    host.logger.info('liveness seeded — first observation of this subject, not notified', {
      tags: dropped.tags,
      meta,
    })
    return
  }
  host.logger.debug('liveness event discarded — the ledger already holds this state', {
    tags: dropped.tags,
    meta,
  })
}
/**
 * `DeviceUnregistered` — a device was DELETED (only `removeDevice` emits it,
 * after the row is gone; a respawn never does). Forget it in the rules,
 * timelapses, digests, alarm lists and mutes — see `device-prune-runner.ts`.
 *
 * Only on the evaluating node (the single writer) and only once the rules
 * are loaded; the pruner then needs `getDevice === null` to agree before it
 * writes anything (D49). Anything that says no is a debug line: the reload
 * tick's reconcile catches the device later.
 */
export async function onDeviceDeleted(host: BootHydrationHost, deviceId: number): Promise<void> {
  if (!host.evaluationActive || !host.rules.isLoaded()) {
    host.logger.debug(
      'deleted device not pruned here — not the evaluating node, or rules not loaded',
      {
        tags: { deviceId },
        meta: { evaluating: host.evaluationActive, rulesLoaded: host.rules.isLoaded() },
      },
    )
    return
  }
  await host.pruner.onDeviceDeleted(deviceId)
}
/**
 * The `device-removal-hook` half (D865, D871): delete every DEVICE row the
 * centre keeps for a deleted device — liveness, alerts, system state, snooze
 * counters, occupancy, track groups, artifact index. Idempotent; throws when
 * a collection could not be cleaned so the caller's retry finishes it.
 */
export async function removeDeviceData(
  host: BootHydrationHost,
  deviceId: number,
): Promise<Record<string, number>> {
  return removeNcDeviceRows(
    {
      ...host.kindDeps(),
      logger: host.logger,
      evictMirrors: (id) => {
        host.liveness.evictDevice(id)
        host.alertStore.evictDevice(id)
        host.stateSummary.evictDevice(id)
        host.occupancyStore.evictDevice(id)
      },
    },
    deviceId,
  )
}
/**
 * Everything the panel reports, on every publish.
 *
 * Synchronous on purpose. The state half refreshes the `deviceState` gate's
 * cache before the next event can be evaluated — the 30-second reload tick
 * used to be the only writer, so a rule gated on `armed_away` kept firing for
 * up to half a minute after a disarm. The tick stays as reconciliation.
 *
 * The transition half becomes an ordinary system event. Never throws into the
 * panel: a notification that could take the panel's own state update with it
 * would make a delivery failure look like an alarm failure.
 */
export function onAlarmPublish(host: BootHydrationHost, report: NcAlarmPublishReport): void {
  const panel = host.alarmPanel
  if (panel === null) return
  host.deviceStates.note(panel.deviceId, report.state)
  host.panelGateWords = {
    deviceId: panel.deviceId,
    words: alarmGateWords(report.state, report.target),
  }
  const transition = report.transition
  if (transition === null) return
  host.scheduleAlarmTransition(panel, transition)
}
/**
 * "Your rule covers this kind, and your own filter dropped it."
 *
 * INFO, not debug, and unconditional. The alternative is what shipped: a
 * rule that selected eleven system-event kinds delivered two of them for
 * four days, and the nine it silently refused produced no line anywhere —
 * indistinguishable from an intake that had stopped emitting. The filter is
 * NAMED, and so is the value that failed it, because the fix is always an
 * edit to that one list.
 *
 * `tags.deviceId` carries the SUBJECT's numeric device id (the system
 * subject's own `deviceId` is the sentinel {@link NC_SYSTEM_DEVICE_ID}), so
 * "why is 102 louder than 2018?" is answerable by grouping. A node- or
 * package-scoped exclusion is about no device and carries no tag.
 */
export function reportSystemFilterExclusion(
  host: BootHydrationHost,
  rule: { readonly id: string; readonly name: string },
  subject: NcRuleSubject,
  filter: NcSystemEventExcludingFilter,
): void {
  const system = subject.systemEvent
  if (system === undefined) return
  host.logger.info('system event excluded by a rule filter', {
    ...(system.deviceId !== undefined ? { tags: { deviceId: system.deviceId } } : {}),
    meta: {
      ruleId: rule.id,
      rule: rule.name,
      kind: system.kind,
      filter,
      eventId: subject.recordId,
      subject: system.subject,
      ...(system.deviceType !== undefined ? { deviceType: system.deviceType } : {}),
      ...(system.nodeId !== undefined ? { nodeId: system.nodeId } : {}),
      ...(system.packageName !== undefined ? { packageName: system.packageName } : {}),
    },
  })
}
/**
 * SAY that the scene gate suppressed this rule.
 *
 * A branch that drops work silently logs it — the three-hour media blackout
 * produced not one line, and a gate is the same shape of failure: from the
 * operator's side "the rule stopped notifying" and "the pipeline stopped
 * working" look identical. `rule did not match` covers it at DEBUG, which is
 * not a level this installation runs at.
 *
 * On CHANGE only, per rule: the alternative is one line per detection on a
 * busy camera, which is silence by a different route. The `deviceId` tag is
 * the SUBJECT's — that is the camera whose notification went missing, and the
 * question is always asked per-camera. The SCENE's own device is named in the
 * meta beside its id, because the two are frequently different cameras.
 */
export function reportSceneSuppression(
  host: BootHydrationHost,
  rule: { readonly id: string; readonly name: string; readonly conditions: NcConditions },
  subject: NcRuleSubject,
): void {
  const condition = rule.conditions.scene
  if (condition === undefined) return
  const observation = host.sceneStates.get(condition.sceneId)
  const reason = sceneGateReason(condition, observation)
  if (host.sceneGateReported.get(rule.id) === reason) return
  host.sceneGateReported.set(rule.id, reason)
  host.logger.info('rule suppressed by its scene condition', {
    tags: { deviceId: subject.deviceId },
    meta: {
      ruleId: rule.id,
      rule: rule.name,
      sceneId: condition.sceneId,
      sceneLabel: observation?.label,
      sceneDeviceId: observation?.deviceId ?? condition.deviceId,
      requiredState: condition.requiredState,
      reason,
    },
  })
}
