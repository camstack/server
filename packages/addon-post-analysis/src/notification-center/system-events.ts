/**
 * Extracted from NotificationCenter (onSystemEvent, admitAlertEpisode, reconcileAlertEpisodes, reloadRules, announceRuleHealth).
 * The class method forwards private state through {@link SystemEventsHost}.
 */

import { NC_ALERT_EPISODE_MAX_AGE_MS, NcAlertEpisodeLedger } from './alert-episode-ledger.js'
import type { NcBatteryReading } from './alerts/battery-band.js'
import { consumablesSliceOf } from './alerts/consumable-routing.js'
import type { NcDeviceAlertSettings } from './alerts/device-alerts.js'
import { NcDeviceAlerts } from './alerts/device-alerts.js'
import { NcCalendarEventsProducer } from './calendar-events/calendar-events-producer.js'
import { NcCalendarEventsStore } from './calendar-events/calendar-events-store.js'
import { NcDeviceDirectory } from './device-directory.js'
import { NcPruneLedger } from './device-prune-ledger.js'
import { NcDeletedSubjectPruner } from './device-prune-runner.js'
import { NcDeviceStateCache } from './device-state-cache.js'
import type { NcIncomingEvent } from './event-intake.js'
import {
  discardedSystemEvent,
  incomingFromSystemEvent,
  parseAddonUpdateComplete,
} from './event-intake.js'
import {
  DeviceLivenessHoldoff,
  isDeviceLivenessKind,
  isNodeLivenessKind,
} from './liveness-holdoff.js'
import { NcLivenessLedger, ledgeredLiveness } from './liveness-ledger.js'
import { OccupancyStore } from './occupancy-store.js'
import { NcUpdateLandings } from './restart-supersede.js'
import { NcRuleAiStore } from './rule-ai-store.js'
import { NcRuleHealthMonitor } from './rule-health.js'
import { NcRuleStore } from './rule-store.js'
import { NcSceneStateCache } from './scene-state-cache.js'
import { NcStateSummaryService } from './state-summary/state-summary-service.js'
import { NcSummaryStore } from './summary/summary-store.js'
import { TimelapseStore } from './timelapse/timelapse-store.js'
import { AddonUpdateCoalescer } from './update-complete-coalescer.js'
import { NcZoneOwnershipCache } from './zone-owner-cache.js'
import type { Alert, AlertEpisodePhase, IScopedLogger, SystemEvent } from '@camstack/types'
import {
  EventCategory,
  alertEpisodeId,
  alertEpisodeKind,
  alertEpisodePayload,
  createEvent,
  errMsg,
  isAlertEpisodeOpen,
  isAlertEpisodeSeverity,
  parseAlertEpisodePayload,
} from '@camstack/types'
import type { NotificationCenterDeps } from './index.js'

/**
 * A `device.state-changed` carrying a BATTERY slice, reduced to what the band
 * derivation reads. `null` for every other cap, and for a slice whose
 * percentage is not a number — a version-skewed emitter must contribute
 * nothing rather than a fabricated 0, which is the same guard the LTS series
 * already applies to this exact payload.
 */
export function batterySliceOf(
  event: SystemEvent,
): { readonly deviceId: number; readonly reading: NcBatteryReading } | null {
  if (event.category !== 'device.state-changed') return null
  const data = event.data
  if (data['capName'] !== 'battery') return null
  const deviceId = data['deviceId']
  const slice = data['slice']
  if (typeof deviceId !== 'number') return null
  if (typeof slice !== 'object' || slice === null || Array.isArray(slice)) return null
  const raw = slice as Record<string, unknown>
  const percentage = raw['percentage']
  const lastUpdated = raw['lastUpdated']
  if (typeof percentage !== 'number' || typeof lastUpdated !== 'number') return null
  return {
    deviceId,
    reading: {
      percentage,
      lastUpdated,
      ...(raw['binary'] === true ? { binary: true } : {}),
    },
  }
}
/** The most alerts one reconcile reads (the alert centre's own ceiling). */
export const NC_ALERT_RECONCILE_LIMIT = 5_000

export interface SystemEventsHost {
  activeOccupancyKeys(): ReadonlySet<string>
  readonly addonUpdates: AddonUpdateCoalescer
  admitAlertEpisode(event: SystemEvent, via: 'bus' | 'reconcile'): boolean
  readonly alertEpisodes: NcAlertEpisodeLedger
  readonly alertEpisodesLoaded: boolean
  announceRuleHealth(): void
  readonly calendarEventsProducer: NcCalendarEventsProducer | null
  readonly calendarEventsRules: NcCalendarEventsStore
  consumeEvent(event: NcIncomingEvent): void
  readonly deps: NotificationCenterDeps
  deviceAlertSettings(): NcDeviceAlertSettings
  readonly deviceAlerts: NcDeviceAlerts
  readonly deviceDirectory: NcDeviceDirectory
  readonly deviceStates: NcDeviceStateCache
  readonly evaluationActive: boolean
  readonly lastSystemLiveness: Map<string, string>
  readonly liveness: NcLivenessLedger
  readonly livenessHoldoff: DeviceLivenessHoldoff
  readonly logger: IScopedLogger
  readonly nodeLivenessHoldoff: DeviceLivenessHoldoff
  noteInertGroupedRules(): void
  readonly now: () => number
  observeAlarmOpenings(): Promise<void>
  readonly occupancyStore: OccupancyStore
  pruneAlarmInputBypasses(): void
  readonly pruneLedger: NcPruneLedger
  readonly pruner: NcDeletedSubjectPruner
  refreshOccupancyWatch(): void
  reloadTexts(): Promise<void>
  reportLivenessDrop(incoming: NcIncomingEvent, verdict: 'seeded' | 'no-flip'): void
  readonly ruleAi: NcRuleAiStore
  readonly ruleHealth: NcRuleHealthMonitor
  readonly rules: NcRuleStore
  readonly sceneStates: NcSceneStateCache
  readonly stateSummary: NcStateSummaryService
  readonly summaryRules: NcSummaryStore
  readonly timelapseRules: TimelapseStore
  readonly updateLandings: NcUpdateLandings
  readonly zoneOwners: NcZoneOwnershipCache
}

/**
 * Event-bus infrastructure/update intake. Invalid payloads are ignored.
 *
 * Two gates stand between the bus and an evaluation, and both REPORT:
 *
 *  1. the intake's own stream-health gate (which flip is an outage), and
 *  2. the durable LIVENESS LEDGER — the first observation of a subject seeds
 *     it silently, a repeat of the state it already holds is discarded, and
 *     only a real flip reaches the rules. See `liveness-ledger.ts`.
 *
 * Nothing is observed on a node that does not evaluate: `consumeEvent` drops
 * the event there anyway, and a ledger row written by a node that will never
 * notify would be a memory of a notification that never happened.
 */
export function onSystemEvent(host: SystemEventsHost, event: SystemEvent): void {
  if (!host.evaluationActive) return
  if (event.category === 'addon.updated') {
    const update = parseAddonUpdateComplete(event.data)
    if (update !== null) {
      host.addonUpdates.observe(update)
      host.stateSummary.observeAddonUpdated(update)
    }
    return
  }
  // The state summary's own reconciles (D647 review I1/I3/I5), BEFORE the
  // intake's gates: a first-packet `stream.online` is no notification but is
  // proof the stream is up, an `update.available` list replaces the node's
  // rows, and an addon starting or a camera being placed revives a node's
  // fault. The last two are never notifications at all.
  host.stateSummary.observeRawEvent(event.category, event.data, host.now(), event.source.nodeId)
  if (event.category === 'alert.episode') {
    // The alert centre's announcement. Until the boot load of the ledger has
    // been attempted it is the reconcile's, not the bus's (D11).
    if (host.alertEpisodesLoaded) host.admitAlertEpisode(event, 'bus')
    return
  }
  if (event.category === 'addon.started' || event.category === 'addon.restarted') return
  if (event.category === 'pipeline.camera-assigned') return
  // THE BATTERY TAP. `EventCategory.DeviceStateChanged` has been subscribed
  // since the liveness intake was written, so every `battery` slice write
  // already arrives here — it was simply dropped, because the liveness branch
  // wants `capName === 'device-status'`. No new bus category, no producer
  // change: the band and the durable episode decide what is worth saying.
  const battery = batterySliceOf(event)
  if (battery !== null) {
    host.deviceAlerts.observeBattery(battery.deviceId, battery.reading)
    return
  }
  // THE CONSUMABLES TAP, on the same slice event and for the same reason.
  // Per ITEM: a vacuum has a brush, a filter and a mop pad, and each gets
  // its own episode. Since D915 the same slice carries the TANKS (a
  // vacuum's water and dust bin, a dishwasher's salt and rinse aid — D642's
  // tank family): `consumablesSliceOf` routes each item by its `kind`.
  const consumables = consumablesSliceOf(event)
  if (consumables !== null) {
    for (const item of consumables.items) {
      host.deviceAlerts.observeConsumableItem(consumables.deviceId, item)
    }
    return
  }
  const lookup = host.deviceDirectory.lookup()
  const incoming = incomingFromSystemEvent(event, lookup)
  if (incoming === null) {
    // A stream-health flip the gate deliberately refused (a lazy-dial
    // suspend, its resume, a first packet, a released broker). Stated out
    // loud: a drop nobody logs reads as an event that never happened, and
    // "why did 101 not notify" is always asked per-camera.
    // …or an ACCESSORY: liveness is a first-level device fact, and 96 of the
    // 100 devices reading offline on this hub are children of a device that
    // is itself online. Same line, because both are the intake's gate saying
    // no, and a drop nobody logs reads as an event that never happened.
    const dropped = discardedSystemEvent(event, lookup)
    if (dropped !== null) {
      host.logger.debug('system event dropped by an intake gate', {
        tags: dropped.tags,
        meta: { category: dropped.category, ...dropped.meta },
      })
    }
    return
  }
  const system = incoming.subject.systemEvent
  // What is STILL TRUE, for the state summary (D647) — before the liveness
  // and dedup gates below, which decide whether to NOTIFY, not what is true.
  if (system !== undefined) host.stateSummary.observeSystem(system, host.now())
  // A landing is a fact about the node, recorded whether or not a rule
  // matches it — it is what makes a late `node-updating` stale (D723).
  if (system !== undefined) host.updateLandings.observe(system, host.now())
  const observation = system !== undefined ? ledgeredLiveness(system) : null
  if (observation !== null) {
    const previous = host.liveness.stateOf(observation.subject)
    const verdict = host.liveness.observe(observation, host.now())
    const holdoff = isNodeLivenessKind(observation.kind)
      ? host.nodeLivenessHoldoff
      : host.livenessHoldoff
    if (verdict === 'seeded') {
      holdoff.remember(observation.subject, observation.state)
      host.reportLivenessDrop(incoming, verdict)
      return
    }
    if (verdict !== 'flip') {
      host.reportLivenessDrop(incoming, verdict)
      return
    }
    if (previous !== undefined) {
      holdoff.rememberIfAbsent(observation.subject, previous)
    }
    // THE ALL-CLEAR SWITCH (the operator's D-4), applied to liveness as it is
    // to the battery band: a device coming BACK is the recovery half, and an
    // operator who turned the all-clear off does not want it.
    //
    // It is applied AFTER the ledger has advanced and after the hold-off has
    // been told, deliberately: suppressing the notification must not suppress
    // the MEMORY of the flip, or the next genuine outage would look like a
    // repeat of a state we never left and would never be announced. That is
    // the same bug D141 recorded for the shared offline/online cooldown, and
    // the exact mistake `nextAlertRow` refuses to make for the battery.
    if (observation.state === 'online' && !host.deviceAlertSettings().notifyRecovery) {
      holdoff.remember(observation.subject, observation.state)
      host.logger.debug('device came back — the all-clear is switched off', {
        tags: incoming.log().tags,
        meta: { subject: observation.subject, kind: observation.kind },
      })
      return
    }
    if (isDeviceLivenessKind(observation.kind) || isNodeLivenessKind(observation.kind)) {
      holdoff.arm(observation.subject, incoming)
      return
    }
  } else if (
    system !== undefined &&
    (system.kind.startsWith('device-') || system.kind.startsWith('stream-'))
  ) {
    // The families the ledger does not govern keep the RAM same-edge dedup —
    // see {@link lastSystemLiveness}.
    if (host.lastSystemLiveness.get(system.subject) === system.kind) return
    host.lastSystemLiveness.set(system.subject, system.kind)
  }
  host.consumeEvent(incoming)
}
/**
 * One edge of an alert episode, from the bus or from the reconcile. The
 * ledger decides whether it is news; only news reaches the rules.
 */
export function admitAlertEpisode(
  host: SystemEventsHost,
  event: SystemEvent,
  via: 'bus' | 'reconcile',
): boolean {
  const payload = parseAlertEpisodePayload(event.data)
  if (payload === null) {
    host.logger.warn('alert episode event with an unreadable payload ignored', {
      meta: { via, eventId: event.id },
    })
    return false
  }
  const verdict = host.alertEpisodes.admit(
    {
      kind: alertEpisodeKind(payload.severity, payload.phase),
      phase: payload.phase,
      episodeId: payload.episodeId,
      alertId: payload.alertId,
    },
    host.now(),
  )
  const meta = {
    via,
    alertId: payload.alertId,
    episodeId: payload.episodeId,
    phase: payload.phase,
    severity: payload.severity,
    verdict,
  }
  if (verdict !== 'notify') {
    host.logger.debug('alert episode edge not notified', { meta })
    return false
  }
  const incoming = incomingFromSystemEvent(event, host.deviceDirectory.lookup())
  if (incoming === null) return false
  host.logger.info('alert episode notified to the rules', { meta })
  host.consumeEvent(incoming)
  return true
}
/**
 * The alerts store against the notified episodes (D11, D49): every OPEN
 * critical/error alert not yet notified is notified, and every notified
 * episode whose alert is CLOSED gets its resolution. Never runs on a ledger
 * the store has not answered — an empty, unread mirror would re-notify every
 * open alert — and never reads absence as closure: an alert that is not in
 * the answer is left alone (rows age out by {@link NC_ALERT_EPISODE_MAX_AGE_MS}).
 */
export async function reconcileAlertEpisodes(host: SystemEventsHost): Promise<void> {
  const read = host.deps.readAlerts
  if (read === undefined || !host.evaluationActive || !host.alertEpisodes.hasAnswered()) return
  let alerts: readonly Alert[]
  try {
    alerts = await read()
  } catch (err) {
    host.logger.warn('alert episode reconcile could not read the alerts', {
      meta: { error: errMsg(err) },
    })
    return
  }
  let notified = 0
  for (const alert of alerts) {
    const episodeId = alertEpisodeId(alert)
    const open = isAlertEpisodeOpen(alert.status)
    if (open && !isAlertEpisodeSeverity(alert.severity)) continue
    if (!open && !host.alertEpisodes.has(episodeId)) continue
    const phase: AlertEpisodePhase = open ? 'raised' : 'resolved'
    const sent = host.admitAlertEpisode(
      createEvent(
        EventCategory.AlertEpisode,
        { type: 'addon', id: 'notification-center' },
        alertEpisodePayload(alert, phase, host.now()),
      ),
      'reconcile',
    )
    if (sent) notified += 1
  }
  const pruned =
    alerts.length < NC_ALERT_RECONCILE_LIMIT
      ? await host.alertEpisodes.pruneOlderThan(host.now() - NC_ALERT_EPISODE_MAX_AGE_MS)
      : 0
  if (notified > 0 || pruned > 0) {
    host.logger.info('alert episodes reconciled', {
      meta: { alerts: alerts.length, notified, pruned },
    })
  }
}
export async function reloadRules(host: SystemEventsHost): Promise<void> {
  await host.rules.load()
  host.noteInertGroupedRules()
  // The reminder sweep rides the rule-reload tick rather than a timer of its
  // own: it is the same cadence, it already runs only on the evaluating node,
  // and a second interval is a second thing to forget to clear on `stop()`.
  // Nothing here reads the condition again — the durable row is the
  // authority, and it moved when the condition did.
  if (host.evaluationActive) host.deviceAlerts.tick()
  // The state summaries ride the same tick (D647): a window closes, the next
  // tick sends it. RAM reads only; single-flight; never awaited here.
  if (host.evaluationActive) {
    void host.stateSummary.tick().catch((err: unknown) => {
      host.logger.warn('state summary tick failed', { meta: { error: String(err) } })
    })
    void host.calendarEventsProducer?.tick().catch((err: unknown) => {
      host.logger.warn('calendar-events tick failed', { meta: { error: String(err) } })
    })
  }
  // The timelapse set rides the same tick: CRUD served on one node becomes
  // visible to the scheduling node here — bounded staleness, never wrongness
  // (D8 reconcile-over-events).
  await host.timelapseRules.load()
  await host.summaryRules.load()
  await host.calendarEventsRules.load()
  // The AI sections ride the same tick and for the same reason: the block is
  // read at ENQUEUE, so an operator switching it on from another node must
  // reach the evaluating one within a tick. Bounded staleness, never
  // wrongness (D8 reconcile-over-events).
  await host.ruleAi.load()
  // …and so does the language. Same reasoning, same bound: a language changed
  // on the hub reaches the evaluating node on the next tick.
  await host.reloadTexts()
  host.refreshOccupancyWatch()
  if (!host.evaluationActive) return
  // Re-read the gated states on the same tick that re-read the rules: the two
  // are only meaningful together (a rule gated on a device nobody watches
  // would never fire).
  await host.deviceStates.refresh()
  // …and the device directory, on the same tick and for the same reason: a
  // camera adopted after the last refresh must be able to report itself
  // offline, and one that was renamed must say its new name. Bounded
  // staleness, never wrongness (D8 reconcile-over-events).
  await host.deviceDirectory.refresh()
  // …and the zone ownership the `zones` conditions scope themselves with. Same
  // tick, same reasoning: a polygon drawn since the last refresh must start
  // scoping its own camera, and a camera whose catalogue cannot be read keeps
  // the flat verdict rather than a guessed one (D49).
  await host.zoneOwners.refresh()
  // …and the scene verdicts the `scene` gates read. Same tick, same reasoning:
  // a scene created, reset or deleted since the last refresh must reach the
  // gate, and a read that fails keeps what is already mirrored rather than
  // un-gating every rule at once (D49).
  host.sceneStates.refresh()
  // On the SAME tick that re-read the states: an excluded sensor's close is
  // only visible here on a hub where the sensor emits no device event.
  await host.observeAlarmOpenings()
  // Same tick that re-read the rules: a bypassed input whose rule was
  // deleted, disabled or re-scoped is no longer an input.
  host.pruneAlarmInputBypasses()
  await host.occupancyStore.pruneExcept(host.activeOccupancyKeys())
  // The deleted-device / deleted-target reconcile rides this tick for the
  // same reason as everything above it (D8: `DeviceUnregistered` is
  // telemetry and may be dropped; `nc.deleteMyTarget` emits nothing at
  // all). AFTER the directory refresh, because its first read is "missing
  // from the last two answered refreshes". No timer of its own (D3).
  // The prune record is written only here, through its own mirror, so this
  // node never re-queries it — except to retry a load that has not yet
  // succeeded (the pruner is inert until one has).
  if (!host.pruneLedger.isLoaded()) await host.pruneLedger.load()
  await host.pruner.reconcileDevices()
  await host.pruner.reconcileTargets()
  // AFTER the prune: its `kept*` records are what says a rule names a
  // deleted device or target (D905).
  host.announceRuleHealth()
}
/**
 * D905 — say which rules cannot work: a row the load skipped, or a rule still
 * naming a device / target the prune confirmed deleted. One edge per rule per
 * distinct set of reasons; a reading that did not answer changes nothing.
 */
export function announceRuleHealth(host: SystemEventsHost): void {
  const edges = host.ruleHealth.evaluate({
    rules: host.rules.isLoaded() ? host.rules.list() : null,
    skipped: host.rules.skippedRows(),
    prunes: host.pruneLedger.isLoaded() ? host.pruner.listPrunes() : null,
  })
  for (const edge of edges) {
    const source = { type: 'addon' as const, id: 'notification-center' }
    if (edge.kind === 'broken') {
      const [first] = edge.reasons
      if (first === undefined) continue
      const offendingIds = [...new Set(edge.reasons.flatMap((r) => r.ids))]
      host.logger.warn('notification rule cannot work — announced', {
        meta: { ruleId: edge.ruleId, rule: edge.ruleName, reasons: edge.reasons },
      })
      host.deps.emitBusEvent?.(
        createEvent(EventCategory.NotificationRuleBroken, source, {
          ruleId: edge.ruleId,
          ruleName: edge.ruleName,
          reason: first.code,
          reasons: edge.reasons,
          offendingIds,
        }),
      )
    } else {
      host.logger.info('notification rule works again — announced', {
        meta: { ruleId: edge.ruleId, rule: edge.ruleName },
      })
      host.deps.emitBusEvent?.(
        createEvent(EventCategory.NotificationRuleRepaired, source, {
          ruleId: edge.ruleId,
          ruleName: edge.ruleName,
        }),
      )
    }
  }
}
