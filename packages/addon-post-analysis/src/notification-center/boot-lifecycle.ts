/**
 * Extracted from NotificationCenter (start, runBootBackfill, stop, closeGroupedWindowsOnStop).
 * The class method forwards private state through {@link BootLifecycleHost}.
 */

import { NcAlertStore } from './alerts/alert-store.js'
import { NcDeviceDirectory } from './device-directory.js'
import { NcDeviceMuteStore } from './device-mute-store.js'
import { NcPruneLedger } from './device-prune-ledger.js'
import { NcDeviceStateCache } from './device-state-cache.js'
import { NC_GROUPED_SHUTDOWN_CLOSE_MS, NcGroupedDelivery } from './grouped/grouped-delivery.js'
import { NcGroupStore } from './grouped/nc-group-store.js'
import { NcLinkedStillShelf } from './linked-stills.js'
import { DeviceLivenessHoldoff } from './liveness-holdoff.js'
import type { NcOutboxEntry } from './outbox.js'
import { NcOutbox } from './outbox.js'
import { NcRuleAiStore } from './rule-ai-store.js'
import { NC_SYSTEM_DEVICE_ID } from './rule-engine.js'
import { NcRuleStore } from './rule-store.js'
import { NcSceneStateCache } from './scene-state-cache.js'
import { NcSequenceStore } from './sequence-store.js'
import { NcSnoozeStore } from './snooze-store.js'
import { NcStateSummaryService } from './state-summary/state-summary-service.js'
import { NcStillShelf } from './still-shelf.js'
import { NcSummaryAiAnalyst } from './summary/summary-ai.js'
import { NcSummaryProducer } from './summary/summary-producer.js'
import { NcSummaryStore } from './summary/summary-store.js'
import { TimelapseScheduler } from './timelapse/timelapse-scheduler.js'
import { TimelapseStore } from './timelapse/timelapse-store.js'
import { AddonUpdateCoalescer } from './update-complete-coalescer.js'
import { NcZoneOwnershipCache } from './zone-owner-cache.js'
import type { IScopedLogger } from '@camstack/types'
import type { NotificationCenterDeps } from './index.js'

export const DEFAULT_DRAIN_INTERVAL_MS = 2_000
export const DEFAULT_RULE_RELOAD_INTERVAL_MS = 30_000
/** How often open critical/error alerts are reconciled against the notified episodes. */
export const NC_ALERT_RECONCILE_INTERVAL_MS = 5 * 60_000

export interface BootLifecycleHost {
  readonly addonUpdates: AddonUpdateCoalescer
  alertReconcileTimer: ReturnType<typeof setInterval> | null
  readonly alertStore: NcAlertStore
  armBootBackfill(): void
  closeGroupedWindowsOnStop(): Promise<void>
  readonly deps: NotificationCenterDeps
  readonly deviceDirectory: NcDeviceDirectory
  readonly deviceMutes: NcDeviceMuteStore
  readonly deviceStates: NcDeviceStateCache
  drainTick(): Promise<void>
  drainTimer: ReturnType<typeof setInterval> | null
  evaluationActive: boolean
  readonly groupStore: NcGroupStore
  readonly grouped: NcGroupedDelivery
  hydrateAlertEpisodes(): Promise<void>
  hydrateLiveness(): Promise<void>
  hydrateNotifiedTracks(rows: readonly NcOutboxEntry[] | null): Promise<void>
  hydrateOccupancy(): Promise<void>
  hydration: Promise<void> | null
  intakeOpenedAt: number
  readonly linkedStills: NcLinkedStillShelf | null
  readonly livenessHoldoff: DeviceLivenessHoldoff
  readonly logger: IScopedLogger
  readonly nodeLivenessHoldoff: DeviceLivenessHoldoff
  noteInertGroupedRules(): void
  readonly now: () => number
  onChain(name: string, run: () => Promise<void>, deviceId: number): Promise<void>
  readonly outbox: NcOutbox
  readonly pruneLedger: NcPruneLedger
  readBootRecentRows(): Promise<readonly NcOutboxEntry[] | null>
  reconcile(): Promise<void>
  reconcileAlertEpisodes(): Promise<void>
  refreshOccupancyWatch(): void
  reloadRules(): Promise<void>
  reloadTexts(): Promise<void>
  reloadTimer: ReturnType<typeof setInterval> | null
  readonly ruleAi: NcRuleAiStore
  readonly rules: NcRuleStore
  readonly sceneStates: NcSceneStateCache
  seedCooldowns(rows: readonly NcOutboxEntry[] | null): void
  readonly sequences: NcSequenceStore
  readonly snoozes: NcSnoozeStore
  readonly stateSummary: NcStateSummaryService
  readonly stills: NcStillShelf | null
  readonly summaryAi: NcSummaryAiAnalyst | null
  readonly summaryProducer: NcSummaryProducer | null
  readonly summaryRules: NcSummaryStore
  readonly timelapseRules: TimelapseStore
  readonly timelapseScheduler: TimelapseScheduler | null
  readonly zoneOwners: NcZoneOwnershipCache
}

/**
 * Load rules (every node — the cap provider serves CRUD from any node).
 * When `evaluation` is true (the designated post-processing node ONLY),
 * open the intake and arm the drain + rule-reload timers.
 *
 * ## `start()` resolving means "the centre is EVALUATING"
 *
 * It does NOT mean the durable back-fill has finished. That contract was
 * written on 2026-08-14 for the two producers (a timelapse render inside
 * `initialize()` took eight capabilities off the cluster for two render
 * timeouts) and it applies to the centre itself for the same reason: this
 * method is awaited by `buildNotificationCenter`, which is awaited by
 * `pipeline-analytics.onInitialize()`, and `addon-runner` publishes a
 * child's capability manifest only AFTER `initialize()` returns.
 *
 * Measured on the live hub 2026-08-17 at ZERO transport contention, the
 * `buildNotificationCenter` boot step took **270 s** — all of it durable
 * back-fill: `hydrateLiveness` (775 subjects), `outbox.load` (743 rows),
 * and two N+1 per-device refresh loops (`readDeviceStates` and
 * `readDeviceZoneIds` issue ONE RPC per watched device, serially). For
 * those 270 s the cluster had no provider for any capability this addon
 * declares, and the intake below had not been opened either — so nothing
 * arriving in that window was late, it was never evaluated at all.
 *
 * ## What stays here, and why
 *
 * Only reads a notification cannot be CORRECT without, and each is one
 * store query:
 *
 *  - the TEXT catalog — a notification built before it goes out in the
 *    wrong language;
 *  - the RULES — without them there is nothing to evaluate;
 *  - the SNOOZE windows and the per-camera MUTES — both SUPPRESS, so a cold
 *    one fails OPEN: the operator gets pushes they explicitly silenced;
 *  - the timelapse + summary rule sets, which the producers armed below read.
 *
 * Everything else is a mirror the 30 s reload tick re-reads anyway, or a
 * boot-once hydration whose cold behaviour is already defined and safe —
 * see {@link runBootBackfill}, which names the direction for each one.
 */
export async function start(
  host: BootLifecycleHost,
  opts: { readonly evaluation: boolean },
): Promise<void> {
  const t0 = Date.now()
  // Per-await timing. Lesson of 2026-08-19, twice in one day: a start()
  // with no internal timing cannot be attributed — 183 s hid in ONE of
  // eight awaits across two boots and every hypothesis about which was
  // wrong until a line said it. Cost: one info line per phase.
  const timed = async (phase: string, run: () => Promise<unknown>): Promise<void> => {
    // Per-call start, not a shared cursor: the six reads run in PARALLEL
    // and a shared cursor would attribute one read's wait to another.
    const started = Date.now()
    await run()
    const now = Date.now()
    host.logger.info('notification start phase', {
      meta: { phase, ms: now - started, sinceStartMs: now - t0 },
    })
  }
  // FIRST, and on every node: the language is what everything below prints
  // in, and a rule loaded before it would simply be evaluated — but a
  // notification built before it would be sent in the wrong language.
  // The six reads are independent — each docblock says "every node" for the
  // same reason — and SERIAL they cost the SUM of the boot-time store
  // latency: measured 2026-08-19, texts 51 s + rules 83 s + mutes 29 s ≈
  // 200 s on the hub while the same code does 0.7/10/3 s elsewhere. In
  // parallel they cost the worst single read. Each stays individually
  // timed; a rejection still fails start(), exactly as the serial chain did.
  await timed('sequences', () => host.sequences.load())
  await Promise.all([
    timed('texts', () => host.reloadTexts()),
    timed('rules', () => host.rules.load()),
    timed('snoozes', () => host.snoozes.load()),
    timed('deviceMutes', () => host.deviceMutes.load()),
    timed('timelapseRules', () => host.timelapseRules.load()),
    timed('summaryRules', () => host.summaryRules.load()),
    timed('ruleAi', () => host.ruleAi.load()),
    timed('devicePrunes', () => host.pruneLedger.load()),
  ])
  // Configure the watched occupancy key set from the current rules (harmless
  // on a non-evaluation node — the watcher is never observed there).
  host.refreshOccupancyWatch()
  host.noteInertGroupedRules()
  if (!opts.evaluation) return
  // BEFORE the intake opens and before the replay: every row still `sealed:false` is an
  // orphan now (review T17 L-5). Never rejects — a failed sweep is a WARN, not a failed boot.
  await timed('groupOrphans', () => host.groupStore.sealOrphans())
  // First read of the scene verdicts. Kept here because it is the one mirror
  // refresh that costs NOTHING: `readSceneStates` is synchronous, served by a
  // provider in this very process (no RPC, no timer, nothing to drop).
  host.sceneStates.refresh()
  // THE INTAKE OPENS HERE. Everything below is armed, not awaited.
  host.intakeOpenedAt = host.now()
  host.evaluationActive = true
  host.drainTimer = setInterval(() => {
    void host.drainTick()
  }, host.deps.drainIntervalMs ?? DEFAULT_DRAIN_INTERVAL_MS)
  host.reloadTimer = setInterval(() => {
    void host.reloadRules()
  }, host.deps.ruleReloadIntervalMs ?? DEFAULT_RULE_RELOAD_INTERVAL_MS)
  host.alertReconcileTimer = setInterval(() => {
    void host.reconcileAlertEpisodes()
  }, host.deps.alertReconcileIntervalMs ?? NC_ALERT_RECONCILE_INTERVAL_MS)
  host.alertReconcileTimer.unref?.()
  // The producer's boot pass IS its back-fill: a window that closed while the
  // process was down is simply a window whose (rule, camera) pair carries no
  // stamp. Best-effort — a producer that cannot start must never cost the
  // notification centre its drain loop. (Both already ARM their boot tick
  // rather than awaiting it — `boot-backfill-never-blocks-start.spec.ts`.)
  const timelapseScheduler = host.timelapseScheduler
  if (timelapseScheduler !== null) {
    await timed('timelapseProducer', () => timelapseScheduler.start()).catch((err: unknown) => {
      host.logger.warn('timelapse producer did not start', {
        meta: { error: String(err) },
      })
    })
  }
  const summaryProducer = host.summaryProducer
  if (summaryProducer !== null) {
    await timed('summaryProducer', () => summaryProducer.start()).catch((err: unknown) => {
      host.logger.warn('summary producer did not start', { meta: { error: String(err) } })
    })
  }
  host.armBootBackfill()
  host.logger.info('notification center started', {
    meta: {
      ms: Date.now() - t0,
      rules: host.rules.list().length,
      timelapseRules: host.timelapseRules.list().length,
      timelapseProducer: host.timelapseScheduler !== null,
      summaryRules: host.summaryRules.list().length,
      summaryProducer: host.summaryProducer !== null,
      // Stated at boot because the alternative is discovering months later
      // that every AI digest on this hub failed open: a rule with `ai` on,
      // on a node with no vision seam, delivers a perfectly ordinary digest.
      summaryAi: host.summaryAi !== null,
      // NOT `pendingOutbox` any more: the outbox has not been read yet, and a
      // count printed before its own load would say 0 on every boot forever.
      backfill: 'armed',
    },
  })
}
/**
 * The boot back-fill: everything `start()` used to await.
 *
 * Ordered by what a cold mirror COSTS, most expensive first — this is a
 * sequence, not a `Promise.all`, because these reads share one UDS store
 * client and racing them is how a boot becomes a queue again.
 *
 *  1. the device directory + the LIVENESS ledger. Cold costs a FLOOD (D130:
 *     one "camera online" per camera on the installation, 2026-08-13), so it
 *     goes first. The ledger's own contract holds in the window: an empty
 *     mirror SEEDS silently rather than notifying (D49, fail toward
 *     discard), and device liveness is additionally held for 5 minutes by
 *     `DeviceLivenessHoldoff` before it can notify at all — which is far
 *     longer than this phase.
 *  2. the OCCUPANCY state. Cold costs a re-announced edge (the cold-baseline
 *     bug, `occupancy-cold-seed.spec.ts`).
 *  3. the OUTBOX horizon, then the COOLDOWN seed. Both cost a REPEAT while
 *     cold — a dedup id nobody remembers, a cooldown nobody recovered — and
 *     the horizon goes first because it is what makes every phase after it
 *     (the reconcile above all) idempotent. The outbox's own cold window is
 *     made safe structurally — see `NcOutbox.load` / `rowExists`.
 *  4. the ZONE ownership. Cold costs a WIDER verdict (a zone-scoped rule
 *     evaluates camera-wide), so it precedes the gates that fail closed.
 *  5. the DEVICE STATES. Cold costs silence — `undefined` never matches — so
 *     it is the safest of the lot and goes after the N+1 above it.
 *  6. the RECONCILE, which replays records persisted across the crash gap.
 *     After the outbox on purpose: the replay is idempotent only through the
 *     dedup horizon.
 *  7. the retention prune. Pure hygiene, nothing reads its result.
 *
 * Every phase reports its own ms. The 2026-08-17 boot could not say which of
 * these owned the 270 s because none of them said anything, and the addon's
 * own per-step timing stopped at `buildNotificationCenter`.
 */
export async function runBootBackfill(host: BootLifecycleHost): Promise<void> {
  const t0 = Date.now()
  const phase = async (name: string, run: () => Promise<void>): Promise<boolean> => {
    // `stop()` clears this. A back-fill phase that ran against a centre which
    // is going away would write mirrors nobody reads and, worse, re-arm the
    // durable rows a shutdown had just settled.
    if (!host.evaluationActive) return false
    const at = Date.now()
    try {
      await run()
    } catch (err) {
      // Loud, and the sequence CONTINUES: these phases are independent, and
      // a directory read that failed must not cost the outbox its hydration.
      host.logger.warn('notification back-fill phase failed', {
        meta: { phase: name, error: String(err) },
      })
    }
    host.logger.info('notification back-fill phase', {
      meta: { phase: name, ms: Date.now() - at, sinceStartMs: Date.now() - t0 },
    })
    return true
  }

  if (
    !(await phase('deviceDirectory', async () => {
      await host.deviceDirectory.refresh()
    }))
  ) {
    return
  }
  if (!(await phase('liveness', () => host.hydrateLiveness()))) return
  // The alert episodes already notified, then ONE reconcile from the alerts
  // store: an open critical alert raised while this centre was down (or whose
  // announcement was dropped) is notified now, once (D11).
  if (!(await phase('alertEpisodes', () => host.hydrateAlertEpisodes()))) return
  // Straight after liveness, and for the same reason it comes second: a cold
  // alert ledger re-opens every episode it already announced, so a hub that
  // restarts twice a day would re-announce every flat battery twice a day.
  // Cost of it landing late is one duplicate per still-low device, once.
  if (
    !(await phase('deviceAlerts', async () => {
      const rows = await host.alertStore.load()
      host.logger.info('device alert ledger reseeded', { meta: { rows } })
    }))
  ) {
    return
  }
  // The state summary's ledgers (D647). Until they load, every section they
  // feed says "unavailable" and nothing is sent — never "none".
  if (
    !(await phase('stateSummary', async () => {
      const loaded = await host.stateSummary.load()
      host.logger.info('state summary ledgers reseeded', { meta: loaded })
    }))
  ) {
    return
  }
  if (!(await phase('occupancy', () => host.hydrateOccupancy()))) return
  // The notified set is hydrated INSIDE the outbox phase, so it precedes the reconcile
  // whatever happens to the load: it is the replay's exactly-once guard (D692 C9). Its
  // read is the boot's ONE 24 h recent-rows read, which the cooldown reseed shares.
  let recentRows: readonly NcOutboxEntry[] | null = null
  if (
    !(await phase('outbox', async () => {
      try {
        await host.outbox.load()
      } finally {
        recentRows = await host.readBootRecentRows()
        await host.hydrateNotifiedTracks(recentRows)
      }
    }))
  ) {
    return
  }
  if (!(await phase('cooldowns', async () => host.seedCooldowns(recentRows)))) return
  if (!(await phase('zoneOwners', () => host.zoneOwners.refresh()))) return
  if (!(await phase('deviceStates', () => host.deviceStates.refresh()))) return
  // The rule identity NAME→ID migration: an enrichment (the engine matches
  // by name meanwhile), and at boot the gallery read behind it cost 119 s —
  // the single largest start() read. See RuleStore.migrateIdentityIds.
  if (!(await phase('ruleIdentityIds', () => host.rules.migrateIdentityIds()))) return
  if (!(await phase('reconcile', () => host.reconcile()))) return
  if (
    !(await phase('prune', async () => {
      const windowMs = (await host.deps.pruneWindows()).outboxMs
      // `null` is the operator's "keep forever": no cutoff, no sweep. It must
      // never become `now - 0`, which prunes the entire outbox.
      if (windowMs !== null) {
        await host.outbox.pruneBefore(host.now() - windowMs)
      }
    }))
  ) {
    return
  }
  host.logger.info('notification center back-fill complete', {
    meta: {
      ms: Date.now() - t0,
      pendingOutbox: host.outbox.pendingCount(),
      dedupHorizon: host.outbox.hydrated(),
    },
  })
}
export async function stop(host: BootLifecycleHost): Promise<void> {
  if (host.drainTimer !== null) {
    clearInterval(host.drainTimer)
    host.drainTimer = null
  }
  if (host.reloadTimer !== null) {
    clearInterval(host.reloadTimer)
    host.reloadTimer = null
  }
  if (host.alertReconcileTimer !== null) {
    clearInterval(host.alertReconcileTimer)
    host.alertReconcileTimer = null
  }
  host.timelapseScheduler?.stop()
  host.summaryProducer?.stop()
  await host.closeGroupedWindowsOnStop()
  // The photographs are RAM and only RAM. A respawn loses whatever had not
  // been attached yet, which costs the picture on rows still in the queue and
  // nothing else — the same trade the group buffer makes.
  host.stills?.clear()
  host.linkedStills?.clear()
  host.addonUpdates.dispose()
  host.livenessHoldoff.dispose()
  host.nodeLivenessHoldoff.dispose()
  // Clearing this is also what STOPS the boot back-fill: it checks the flag
  // between phases, so a shutdown that lands mid-hydration abandons the rest
  // instead of writing mirrors nobody will read (the `alarmPanelConvergence`
  // precedent — work armed off the boot path can outlive the boot).
  host.evaluationActive = false
  // Deliberately NOT awaited: a phase can be sitting in a 50 s store query,
  // and a shutdown that waits for it is the stall this whole change exists to
  // remove — one level down. The flag makes every phase AFTER the current one
  // a no-op, which is all a shutdown needs.
  host.hydration = null
}
/**
 * Spec §3.5: a deliberate stop must not cost the notification — and must not stall
 * either. Every grouped window is closed with `shutdown` on the evaluation chain (behind
 * whatever it is already doing), its record SEALS are flushed, and the stop waits for
 * THAT one promise for at most {@link NC_GROUPED_SHUTDOWN_CLOSE_MS}. Past the bound it
 * proceeds: the watermark hold and the notified-set hydration (Task 10) recover a window
 * whose close never finished, so the fallback costs a replay, not a message.
 *
 * The close is ALWAYS appended (review T9b L-1): an admission still queued on the chain
 * when the stop begins opens its window before the close runs, so "no window open now"
 * is not "no window to close". The seals are part of the bound (review T9b M-2): a window
 * the stop sent must not be left `sealed:false` forever.
 *
 * Nothing leaves silently (D391, review T8 L-4): a close that throws is WARNed per window
 * by the delivery (`grouped window close failed — window lost`), and the timeout names
 * every window still open or still closing when the bound ran out — never one that
 * closed in time.
 */
export async function closeGroupedWindowsOnStop(host: BootLifecycleHost): Promise<void> {
  let closedAll = false
  const closing = host
    .onChain('grouped-shutdown-close', () => host.grouped.closeAll('shutdown'), NC_SYSTEM_DEVICE_ID)
    .then(() => {
      closedAll = true
      return host.groupStore.flush()
    })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), NC_GROUPED_SHUTDOWN_CLOSE_MS)
  })
  try {
    const winner = await Promise.race([closing.then(() => 'closed' as const), timedOut])
    if (winner !== 'timeout') return
    if (closedAll) {
      // Every window closed (its message is enqueued); only a record write is stuck.
      host.logger.warn(
        'grouped window records not sealed within the shutdown bound — they read as open',
        { meta: { boundMs: NC_GROUPED_SHUTDOWN_CLOSE_MS } },
      )
      return
    }
    const left = [...host.grouped.closingWindows(), ...host.grouped.openWindows()]
    if (left.length === 0) {
      // The chain is busy with something else; no grouped window is at stake.
      host.logger.debug('grouped shutdown close timed out with no grouped window left', {
        meta: { boundMs: NC_GROUPED_SHUTDOWN_CLOSE_MS },
      })
      return
    }
    host.logger.warn(
      'grouped windows not closed within the shutdown bound — the restart replay recovers them',
      {
        meta: {
          boundMs: NC_GROUPED_SHUTDOWN_CLOSE_MS,
          windows: left.map((w) => ({ windowKey: w.key, deviceId: w.deviceId })),
        },
      },
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
