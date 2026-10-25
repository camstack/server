/**
 * Extracted from NotificationCenter (buildProvider).
 * The class method forwards private state through {@link RulesProviderHost}.
 */

import { requireCapCaller } from './cap-caller.js'
import { buildClipRetentionPlan } from './clip-retention-ask.js'
import { guardPatchDetectionAudio, guardRuleDetectionAudio } from './detection-audio-guard.js'
import {
  NcDeviceCompatWarnSampler,
  guardPatchDeviceCompat,
  guardRuleDeviceCompat,
} from './device-compat-guard.js'
import { NcDeviceMuteStore } from './device-mute-store.js'
import { guardPatchDevicesExclude, guardRuleDevicesExclude } from './device-scope-guard.js'
import { buildTemplateVars, renderRowTitle } from './dispatcher.js'
import { guardPatchGrouping, guardRuleGrouping } from './grouping-guard.js'
import { guardPatchMedia, guardRuleMedia } from './media-guard.js'
import { assertPatchKeepsAddressee, assertRuleHasAddressee } from './nc-actions.js'
import type { NcOutboxEntry, NcOutboxPayload, NcOutboxRecordKind } from './outbox.js'
import { NcOutbox } from './outbox.js'
import { NcRuleActionRunner } from './rule-actions.js'
import { guardPatchFamily, guardRuleFamily } from './rule-family-guard.js'
import { NC_RULE_LAST_RUNS_SCAN_LIMIT, summariseRuleLastRuns } from './rule-last-runs.js'
import { NcRuleStore } from './rule-store.js'
import {
  guardPatchSystemEventDelivery,
  guardRuleSystemEventDelivery,
} from './rule-summary-guard.js'
import { guardPatchSensorTransition, guardRuleSensorTransition } from './sensor-transition-guard.js'
import { NcSequenceStore } from './sequence-store.js'
import { NcSnoozeStore } from './snooze-store.js'
import { NcStateSummaryService } from './state-summary/state-summary-service.js'
import { previewTemplate } from './template-preview.js'
import { NcTextCatalog } from './text-catalog.js'
import type {
  INotificationRulesProvider,
  IScopedLogger,
  NcAlarmConfig,
  NcAlarmProfilesView,
  NcAlarmSensors,
  NcAlarmSensorsInput,
  NcAlarmSettingsPatch,
  NcHistoryEntry,
  NcRule,
  NcRuleInput,
  NcSnooze,
  NcSnoozeInput,
  NcTestResult,
} from '@camstack/types'
import { NC_CONDITION_CATALOG, NC_TAXONOMY, servedTemplateVars } from '@camstack/types'
import { randomUUID } from 'node:crypto'
import type { NcAlarmPanelPort, NotificationCenterDeps } from './index.js'

/**
 * Project a durable outbox row onto a delivery-history entry (the cap
 * contract). History is a VIEW — this is the ONLY mapping; there is no
 * separate history collection to write, so a row and its history entry can
 * never disagree. `ruleName` + `subject` come from the intent snapshot
 * frozen at enqueue; `error` surfaces only on a dead row (`lastError`).
 */
export function historyRecordKind(kind: NcOutboxRecordKind): NcHistoryEntry['recordKind'] {
  if (kind === 'audio-event' || kind === 'audio-window') return 'object-event'
  if (kind === 'timelapse' || kind === 'ai-summary' || kind === 'calendar-events') {
    return 'system-event'
  }
  return kind
}
/**
 * The system-event half of a history row, in the CAP's shape.
 *
 * The cap contract (`NcHistoryEntry`, frozen in `@camstack/types`) wants a
 * title and a body, and a row written since the text catalog carries keys
 * instead. So history resolves them through the SAME catalog the delivery used
 * — history must read as what the operator was actually sent, and a page that
 * showed a key while the phone showed a sentence would be a second vocabulary
 * to keep in step. A pre-catalog row falls back to the pair frozen on it.
 */
export function historySystemEvent(
  texts: NcTextCatalog,
  entry: NcOutboxEntry,
  systemEvent: NonNullable<NcOutboxPayload['subject']['systemEvent']>,
): NonNullable<NcHistoryEntry['subject']['systemEvent']> {
  // The SAME variables the dispatcher rendered with (D708): the frozen params
  // alone lack `{{rule}}` (and every other row-level variable), so a summary
  // the phone titled "Stato: 17" read ": 17" here. No device name and no zone
  // labels are looked up — a system row's frozen params carry its names.
  const vars = buildTemplateVars(texts, entry, '', [])
  // The COUNT the row froze, exactly as the dispatcher uses it. Without it the
  // history read every pluralised sentence as its `other` variant, so a row a
  // phone showed as "the porch window is open" appeared in history as
  // "1 sensors are open" — one row, two sentences.
  const count = systemEvent.textCount
  const resolve = (key: string | undefined, frozen: string | undefined): string => {
    if (key !== undefined && texts.has(key)) {
      return texts.text({ key, vars, ...(count !== undefined ? { count } : {}) })
    }
    return frozen ?? ''
  }
  return {
    kind: systemEvent.kind,
    subject: systemEvent.subject,
    // The title exactly as it was SENT: authored template, catalog key, frozen.
    title: renderRowTitle(texts, entry, vars),
    body: resolve(systemEvent.bodyKey, systemEvent.body),
    data: { ...systemEvent.data },
  }
}
export function outboxEntryToHistory(texts: NcTextCatalog, entry: NcOutboxEntry): NcHistoryEntry {
  const s = entry.payload.subject
  return {
    id: entry.id,
    ruleId: entry.ruleId,
    ruleName: entry.payload.ruleName,
    // Cap-facing downgrade, same reason as `recordKind` below: `NcDelivery` is
    // FROZEN and carries no `timelapse` member. A scheduled timelapse is the
    // one NC notification that fires on a schedule boundary rather than on a
    // persisted record, which is exactly what `system-event` already means to
    // this enum. The durable row keeps `delivery: 'timelapse'`.
    delivery:
      entry.payload.delivery === 'timelapse' ||
      entry.payload.delivery === 'ai-summary' ||
      entry.payload.delivery === 'calendar-events'
        ? 'system-event'
        : entry.payload.delivery,
    targetId: entry.targetId,
    deviceId: entry.deviceId,
    // Cap-facing downgrade: `audio-event` and `timelapse` are internal record
    // kinds not carried by `NcHistoryRecordKindSchema`. Project `audio-event`
    // to `object-event` (its `immediate`-delivery sibling) and `timelapse` to
    // `system-event` (its boundary-fired sibling) so the baked history router
    // accepts the row train-free; the durable outbox row keeps the true kind.
    // The subject `className` (`audio-<id>` / `timelapse`) still identifies it
    // in history.
    recordKind: historyRecordKind(entry.recordKind),
    recordId: entry.recordId,
    ...(entry.trackId !== undefined ? { trackId: entry.trackId } : {}),
    status: entry.status,
    attempts: entry.attempts,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(entry.lastError !== undefined ? { error: entry.lastError } : {}),
    subject: {
      className: s.className,
      ...(s.label !== undefined ? { label: s.label } : {}),
      ...(s.confidence !== undefined ? { confidence: s.confidence } : {}),
      zones: [...s.zones],
      timestamp: s.timestamp,
      ...(s.systemEvent !== undefined
        ? { systemEvent: historySystemEvent(texts, entry, s.systemEvent) }
        : {}),
    },
    // A reference, never the bytes — see `NcOutboxPayload.artifactIds`. Only
    // present when the delivery actually indexed something.
    ...(entry.payload.artifactIds !== undefined && entry.payload.artifactIds.length > 0
      ? { artifactIds: [...entry.payload.artifactIds] }
      : {}),
  }
}
/**
 * The server-derived caller of a snooze operation. Never client-trusted — the
 * hub router injects it for a `caller: 'required'` method, and the `nc.*`
 * bridge resolves it fail-closed.
 */
export interface NcSnoozeCaller {
  readonly userId: string
  readonly isAdmin: boolean
}

export interface RulesProviderHost {
  readonly actionRunner: NcRuleActionRunner | null
  alarmConfig(): Promise<NcAlarmConfig>
  alarmSensors(input: NcAlarmSensorsInput): Promise<NcAlarmSensors>
  cancelSnooze(snoozeId: string, caller: NcSnoozeCaller): Promise<void>
  createSnooze(input: NcSnoozeInput, caller: NcSnoozeCaller): Promise<NcSnooze>
  readonly deps: NotificationCenterDeps
  readonly deviceCompatWarnSampler: NcDeviceCompatWarnSampler
  deviceIdForRuleActions(rule: NcRule): number
  readonly deviceMutes: NcDeviceMuteStore
  dryRun(rule: NcRuleInput, lookbackMinutes: number): Promise<readonly NcTestResult[]>
  readonly logger: IScopedLogger
  mutateAlarmProfile(
    run: (panel: NcAlarmPanelPort) => Promise<NcAlarmProfilesView>,
  ): Promise<NcAlarmConfig>
  readonly now: () => number
  readonly outbox: NcOutbox
  readonly rules: NcRuleStore
  readonly sequences: NcSequenceStore
  setAlarmConfig(patch: NcAlarmSettingsPatch): Promise<NcAlarmConfig>
  readonly snoozes: NcSnoozeStore
  readonly stateSummary: NcStateSummaryService
  readonly texts: NcTextCatalog
  validateTargetRefs(targetIds: readonly string[]): Promise<void>
}

export function buildProvider(host: RulesProviderHost): INotificationRulesProvider {
  return {
    listRules: async () => ({ rules: [...host.rules.list()] }),
    // The proactive half of the clip ring (see `clip-retention-ask.ts`).
    // Cheap and pure — it reads the rule mirror this process already holds,
    // and every node's stream broker polls it on its own catalog reconcile
    // tick, so a rule created here reaches every ring within that tick
    // (D8: reconcile over events, bounded staleness, never wrongness).
    getClipRetentionAsks: async () =>
      buildClipRetentionPlan(host.rules.list(), host.rules.isLoaded()),
    getRule: async ({ ruleId }) => ({ rule: host.rules.get(ruleId) }),
    createRule: async ({ rule, caller }) => {
      assertRuleHasAddressee(rule.targets, rule.targetUsers)
      // One authority for the D637 family invariant (shared with nc.createRule).
      guardRuleFamily(rule, { logger: host.logger, by: caller.userId })
      // D640: a sensor edge belongs to a device-event rule (shared with nc.createRule).
      guardRuleSensorTransition(rule, { logger: host.logger, by: caller.userId })
      // D690: a detection rule names no sound (shared with nc.createRule).
      guardRuleDetectionAudio(rule, { logger: host.logger, by: caller.userId })
      // D692: only an immediate detection rule may be grouped (shared with nc.createRule).
      guardRuleGrouping(rule, { logger: host.logger, by: caller.userId })
      // D897: the picture mode and the trigger-zone flag the rule can honour.
      guardRuleMedia(rule, { logger: host.logger, by: caller.userId })
      // D641: a device exclusion belongs where `devices` does (shared with nc.createRule).
      guardRuleDevicesExclude(rule, { logger: host.logger, by: caller.userId })
      // Operator ruling 2026-10-01: every included device can actually
      // produce this rule kind's subject.
      await guardRuleDeviceCompat(rule, {
        logger: host.logger,
        by: caller.userId,
        listDeviceIdsByCaps: host.deps.listDeviceIdsByCaps,
        sampler: host.deviceCompatWarnSampler,
      })
      // D647: a scheduled summary belongs to device-events / system rules only.
      guardRuleSystemEventDelivery(rule, { logger: host.logger, by: caller.userId })
      await host.validateTargetRefs(rule.targets.map((t) => t.targetId))
      const created = await host.rules.create(rule, caller.userId)
      host.logger.info('notification rule created', {
        meta: { ruleId: created.id, name: created.name, by: caller.userId },
      })
      return { rule: created }
    },
    updateRule: async ({ ruleId, patch, clear, caller }) => {
      if (patch.targets !== undefined) {
        await host.validateTargetRefs(patch.targets.map((t) => t.targetId))
      }
      // One authority for the addressee invariant (shared with nc.updateRule).
      const existing = host.rules.get(ruleId)
      assertPatchKeepsAddressee(existing, patch, clear ?? [])
      // ...and for the D637 family invariant, judged on the MERGED rule.
      guardPatchFamily(existing, patch, { logger: host.logger, by: caller.userId, ruleId })
      guardPatchSensorTransition(existing, patch, {
        logger: host.logger,
        by: caller.userId,
        ruleId,
      })
      guardPatchDetectionAudio(existing, patch, {
        logger: host.logger,
        by: caller.userId,
        ruleId,
      })
      // D692: the MERGED rule, `clear` included (shared with nc.updateRule).
      guardPatchGrouping(existing, patch, clear ?? [], {
        logger: host.logger,
        by: caller.userId,
        ruleId,
      })
      guardPatchMedia(existing, patch, { logger: host.logger, by: caller.userId, ruleId })
      guardPatchDevicesExclude(existing, patch, {
        logger: host.logger,
        by: caller.userId,
        ruleId,
      })
      await guardPatchDeviceCompat(existing, patch, {
        logger: host.logger,
        by: caller.userId,
        ruleId,
        listDeviceIdsByCaps: host.deps.listDeviceIdsByCaps,
        sampler: host.deviceCompatWarnSampler,
      })
      guardPatchSystemEventDelivery(existing, patch, clear ?? [], {
        logger: host.logger,
        by: caller.userId,
        ruleId,
      })
      // Strip the persisted-only `disabledTargetIds` from an admin patch: the
      // per-target opt-out set is toggled ONLY via the owner-checked
      // `setRuleTargetEnabled` path, so a stale full-object patch (which the
      // widened NcRulePatchSchema now accepts for the store-internal path)
      // must never clobber it. Restores the structural persisted-only
      // guarantee (A3 MEDIUM-1).
      const { disabledTargetIds: _optOut, ...safePatch } = patch
      const updated = await host.rules.update(ruleId, safePatch, clear ?? [])
      host.logger.info('notification rule updated', {
        meta: {
          ruleId,
          by: caller.userId,
          ...(clear && clear.length > 0 ? { cleared: clear } : {}),
        },
      })
      return { rule: updated }
    },
    deleteRule: async ({ ruleId }) => {
      await host.rules.delete(ruleId)
      return { success: true }
    },
    setRuleEnabled: async ({ ruleId, enabled }) => {
      const updated = await host.rules.setEnabled(ruleId, enabled)
      const bindings = enabled ? updated.actions?.onActivation : updated.actions?.onDeactivation
      if (bindings !== undefined && bindings.length > 0 && host.actionRunner !== null) {
        void host.actionRunner.runBindings({
          ruleId: updated.id,
          ruleName: updated.name,
          deviceId: host.deviceIdForRuleActions(updated),
          bindings,
          lookup: (id) => host.sequences.get(id),
        })
      }
      return { success: true }
    },
    listSequences: async () => ({ sequences: [...host.sequences.list()] }),
    getSequence: async ({ sequenceId }) => ({ sequence: host.sequences.get(sequenceId) }),
    createSequence: async ({ sequence }) => {
      const created = await host.sequences.create(sequence)
      host.logger.info('notification sequence created', { meta: { sequenceId: created.id } })
      return { sequence: created }
    },
    updateSequence: async ({ sequenceId, sequence }) => {
      const updated = await host.sequences.update(sequenceId, sequence)
      host.logger.info('notification sequence updated', { meta: { sequenceId } })
      return { sequence: updated }
    },
    deleteSequence: async ({ sequenceId }) => {
      await host.sequences.delete(sequenceId)
      host.logger.info('notification sequence deleted', { meta: { sequenceId } })
      return { success: true }
    },
    testRule: async ({ rule, lookbackMinutes }) => ({
      results: [...(await host.dryRun(rule, lookbackMinutes))],
    }),
    // The state summary this rule (saved or a draft) would send NOW (D647).
    // RAM only; sends and stamps nothing.
    previewStateSummary: async ({ rule }) => host.stateSummary.preview(rule),
    // `taxonomy` is what turns every list condition from a free-text box into
    // a grouped picker. It was already served on the `nc.*` bridge action;
    // serving it here too is what lets the admin UI, which reaches the cap,
    // stop asking operators to type `person` from memory.
    getConditionCatalog: async () => ({
      catalog: [...NC_CONDITION_CATALOG],
      taxonomy: NC_TAXONOMY,
    }),
    // The SERVED catalog (D642): kinds the installed viewers cannot parse are held back.
    getTemplateCatalog: async () => ({ vars: servedTemplateVars() }),
    previewTemplate: async (input) => previewTemplate(host.texts, input),
    getHistory: async ({ filter }) => {
      const entries = await host.outbox.queryHistory({
        ...(filter.ruleId !== undefined ? { ruleId: filter.ruleId } : {}),
        ...(filter.deviceId !== undefined ? { deviceId: filter.deviceId } : {}),
        ...(filter.status !== undefined ? { status: filter.status } : {}),
        ...(filter.since !== undefined ? { since: filter.since } : {}),
        ...(filter.until !== undefined ? { until: filter.until } : {}),
        limit: filter.limit,
      })
      // Per-row guard (review MEDIUM): rowToEntry validates only top-level
      // fields, so one corrupt/partial payload (missing subject/zones) would
      // otherwise throw and fail the WHOLE history page. Skip malformed rows
      // — mirrors rowToEntry's own null-return discipline.
      const mapped: NcHistoryEntry[] = []
      for (const entry of entries) {
        try {
          mapped.push(outboxEntryToHistory(host.texts, entry))
        } catch {
          host.logger.debug('getHistory: skipping malformed outbox row', {
            meta: { id: entry.id },
          })
        }
      }
      return { entries: mapped }
    },
    // ONE bounded read of the outbox, never a `getHistory` per rule — see
    // `rule-last-runs.ts`. The window is the prune window read NOW, so the
    // horizon the answer names is the one the outbox is actually kept for.
    getRuleLastRuns: async () => {
      const now = host.now()
      const windowMs = (await host.deps.pruneWindows()).outboxMs
      const read = await host.outbox.queryLastRunRows(
        windowMs !== null ? now - windowMs : null,
        NC_RULE_LAST_RUNS_SCAN_LIMIT,
      )
      return summariseRuleLastRuns(read, { now, windowMs })
    },
    resolveArtifactUrl: async ({ artifactId }) => ({
      url: (await host.deps.resolveArtifactUrl?.(artifactId)) ?? null,
    }),

    listDeviceMutes: async () => ({ mutedDeviceIds: host.deviceMutes.listMuted() }),
    setDeviceMuted: async ({ deviceId, muted }) => {
      await host.deviceMutes.setMuted(deviceId, muted)
      // An indefinite silence that leaves no record is the failure this
      // whole surface exists to remove — both directions are logged.
      host.logger.info(muted ? 'camera notifications MUTED' : 'camera notifications unmuted', {
        tags: { deviceId },
        meta: { mutedCameras: host.deviceMutes.listMuted().length },
      })
      return { success: true as const }
    },

    listSnoozes: async ({ caller }) => {
      const who = requireCapCaller('listSnoozes', caller)
      return { snoozes: [...host.snoozes.listVisibleTo(who.userId, who.isAdmin)] }
    },
    createSnooze: async ({ snooze, caller }) => ({
      snooze: await host.createSnooze(snooze, requireCapCaller('createSnooze', caller)),
    }),
    cancelSnooze: async ({ snoozeId, caller }) => {
      await host.cancelSnooze(snoozeId, requireCapCaller('cancelSnooze', caller))
      return { success: true }
    },

    getAlarmConfig: async () => host.alarmConfig(),
    getAlarmSensors: async (input) => host.alarmSensors(input),
    setAlarmConfig: async ({ patch }) => host.setAlarmConfig(patch),
    createAlarmProfile: async ({ name, cloneFromId }) =>
      host.mutateAlarmProfile((panel) =>
        panel.createProfile({
          name,
          newId: randomUUID(),
          source:
            cloneFromId === undefined
              ? { kind: 'defaults' }
              : { kind: 'clone', fromId: cloneFromId },
        }),
      ),
    renameAlarmProfile: async ({ id, name }) =>
      host.mutateAlarmProfile((panel) => panel.renameProfile(id, name)),
    deleteAlarmProfile: async ({ id }) =>
      host.mutateAlarmProfile((panel) => panel.deleteProfile(id)),
    activateAlarmProfile: async ({ id }) =>
      host.mutateAlarmProfile((panel) => panel.activateProfile(id)),
  }
}
