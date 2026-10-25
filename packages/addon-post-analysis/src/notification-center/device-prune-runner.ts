/**
 * The notification centre forgets a DELETED device, and a deleted delivery
 * target — the I/O half of `device-prune.ts`.
 *
 * ── When a device counts as deleted ────────────────────────────────────────
 *
 * Two doors, one bar:
 *
 *  - the `DeviceUnregistered` event. `removeDevice` is its ONLY emitter and
 *    emits it after the sqlite row is gone; a runner respawn or rebuild goes
 *    through `decommission`, which never emits it
 *    (`packages/system/.../device-meta-actions.ts`, pinned by a system spec).
 *  - the reload-tick reconcile (D8: events are telemetry and may be dropped).
 *    An id is a candidate only when it is missing from the last TWO answered
 *    directory refreshes (`NcDeviceDirectory.absentFromLastTwoAnswers`).
 *
 * Either way the destructive reading needs a SECOND read to agree before
 * anything is written (D49): `deviceManager.getDevice` answering `null`, which
 * it does only once the persisted row is deleted. A read that throws, or that
 * answers a device, changes nothing. No timer, no retry, no registry scan
 * (D3): a candidate that did not confirm is simply looked at again on the next
 * tick that already runs.
 *
 * ── The bound ──────────────────────────────────────────────────────────────
 *
 * A reconcile that would act on more than {@link NC_PRUNE_RECONCILE_LIMIT}
 * subjects at once prunes NOTHING and warns. Sixteen devices vanishing between
 * two ticks is a broken registry or a wiped hub, not sixteen deletions — the
 * same shape as the declared-device withdrawal sweep.
 *
 * ── Targets ────────────────────────────────────────────────────────────────
 *
 * `nc.deleteMyTarget` emits nothing, so targets have only the reconcile. The
 * catalog is a concat fan-out across every `notification-output` provider,
 * which makes it PARTIAL whenever one provider is down, not only empty. So a
 * target is a candidate only when two consecutive answered (non-empty,
 * successful) catalogs lack it AND its own provider — remembered from an
 * earlier catalog — answered in both. A target this process never saw has no
 * known provider and is left alone: unknown is not evidence.
 *
 * Every mutation is serialised through one chain, so an event and a tick can
 * never plan against the same snapshot and write twice.
 */

import type { IScopedLogger, LogTags, NcAlarmSettings, NcAlarmSettingsPatch } from '@camstack/types'
import type { NcDeviceDirectory } from './device-directory.js'
import type { NcDeviceMuteStore } from './device-mute-store.js'
import {
  isEmptyPlan,
  type NcPruneGuardKey,
  type NcPruneKind,
  type NcPruneNote,
  type NcPrunePlan,
  type NcPruneSnapshot,
  type NcPruneSource,
  planDevicePrune,
  planSubjects,
  planTargetPrune,
  referencedDeviceIds,
  referencedTargetIds,
} from './device-prune.js'
import type { NcPruneLedger, NcPruneRecord } from './device-prune-ledger.js'
import type { NcTargetCatalogSnapshot } from './dispatcher.js'
import type { NcRuleStore } from './rule-store.js'
import type { NcSummaryStore } from './summary/summary-store.js'
import type { TimelapseStore } from './timelapse/timelapse-store.js'

/** A snapshot holding nothing — a fresh re-plan fills in the one row it is about. */
const NO_SNAPSHOT: NcPruneSnapshot = {
  rules: [],
  timelapse: [],
  summary: [],
  alarm: null,
  mutedDeviceIds: [],
}

/** Above this many subjects in one reconcile pass, prune nothing. */
export const NC_PRUNE_RECONCILE_LIMIT = 16

/** The alarm panel, as the prune needs it — its lists and its exclusions. */
export interface NcPruneAlarmPort {
  readonly deviceId: number
  settings(): NcAlarmSettings
  applySettings(patch: NcAlarmSettingsPatch): Promise<NcAlarmSettings>
  excludedDevices(): readonly number[]
  /** Drop one device from the CURRENT arm's exclusions (it was deleted). */
  forgetExcluded(deviceId: number): void
}

/**
 * The device-alert rows (battery, consumables), as the prune needs them.
 * `NcDeviceAlerts` in production. A device with an alert row is almost never
 * named by a rule, so the reconcile asks this port which devices it holds.
 */
export interface NcPruneAlertPort {
  deviceIds(): readonly number[]
  /** Drop every alert row of a deleted device; how many went. */
  forget(deviceId: number): Promise<number>
}

export interface NcDeletedSubjectPrunerDeps {
  readonly logger: IScopedLogger
  readonly now: () => number
  readonly ledger: NcPruneLedger
  readonly rules: NcRuleStore
  readonly timelapse: TimelapseStore
  readonly summary: NcSummaryStore
  readonly mutes: NcDeviceMuteStore
  readonly alarm: () => NcPruneAlarmPort | null
  /** Absent ⇒ no alert rows to forget (a spec, or a node that holds none). */
  readonly alerts?: NcPruneAlertPort
  readonly directory: NcDeviceDirectory
  /**
   * The second read: true ONLY when `deviceManager.getDevice` answered `null`
   * (the row is deleted). Absent ⇒ no device is ever pruned — an unwired
   * second read must never read as agreement.
   */
  readonly isDeviceDeleted: ((deviceId: number) => Promise<boolean>) | undefined
  /**
   * The target catalog the DELIVERY path already cached, while fresh
   * (`NcDispatcher.catalogSnapshot`). Never a read of its own: a cluster
   * fan-out every tick to find the rare deleted target is the repeated broad
   * read this repo does not make. `null` ⇒ no answer this tick.
   */
  readonly targetCatalog: () => NcTargetCatalogSnapshot | null
}

/** The `tags` half of a prune line — `{ deviceId }` for a device, none for a target. */
interface NcPruneLogTags {
  readonly tags?: LogTags
}

/** One answered target catalog: which targets, and which providers answered. */
interface NcCatalogAnswer {
  readonly ids: ReadonlySet<string>
  readonly providers: ReadonlySet<string>
}

export class NcDeletedSubjectPruner {
  private chain: Promise<void> = Promise.resolve()
  /** The last two ANSWERED target catalogs, oldest first. */
  private catalogs: readonly NcCatalogAnswer[] = []
  /** The cache generation last taken as an answer — the same one is not two. */
  private lastCatalogGeneration: number | null = null
  /** Target id → the provider that served it, from every catalog seen. */
  private readonly providerOf = new Map<string, string>()
  /** Per pass kind, the candidate count of the last aborted pass — the WARN fires on change only. */
  private readonly lastAbort = new Map<'device' | 'target', number>()
  /**
   * `kind:ruleId` → the mirror's `updatedAt` when a fresh read found the
   * STORED row invalid. Such a rule is left out of planning until its row
   * changes (a new `updatedAt`), so a bad row costs one WARN, not a second
   * read per tick.
   */
  private readonly unwritable = new Map<string, number>()
  /** Referenced targets already said to be unprunable — said once per process. */
  private readonly unprunableSaid = new Set<string>()

  constructor(private readonly deps: NcDeletedSubjectPrunerDeps) {}

  /** `nc.listPrunes` — every recorded prune, newest first. */
  listPrunes(): readonly NcPruneRecord[] {
    return this.deps.ledger.list()
  }

  /**
   * The `DeviceUnregistered` door. The CALLER has already established that
   * this is the evaluating node and that the rules are loaded.
   */
  onDeviceDeleted(deviceId: number): Promise<void> {
    return this.serialise(async () => {
      if (!this.ready('event', deviceId)) return
      if (!(await this.confirmDeleted(deviceId, 'event'))) return
      await this.forgetAlerts(deviceId, 'event')
      const deleted = new Set([deviceId])
      await this.apply(planDevicePrune(this.snapshot(), deleted, this.guard()), 'event', (fresh) =>
        planDevicePrune(fresh, deleted, this.guard()),
      )
    }, deviceId)
  }

  /** The reload-tick door for devices. Runs after the directory refresh. */
  reconcileDevices(): Promise<void> {
    return this.serialise(async () => {
      if (!this.ready('reconcile')) return
      const directory = this.deps.directory
      // The alert rows' devices are candidates beside the ones a rule names:
      // a battery device is almost never on a rule, and its rows would
      // otherwise outlive it forever.
      const alerting = new Set(this.deps.alerts?.deviceIds() ?? [])
      const candidates = [
        ...new Set([...referencedDeviceIds(this.snapshot()), ...alerting]),
      ].filter((id) => directory.absentFromLastTwoAnswers(id))
      if (candidates.length === 0) return
      const first = planDevicePrune(this.snapshot(), new Set(candidates), this.guard())
      const subjects = [
        ...new Set([
          ...[...planSubjects(first)].map(Number),
          ...candidates.filter((id) => alerting.has(id)),
        ]),
      ]
      if (subjects.length === 0) return
      if (!this.withinBound('device', subjects.map(String))) return
      const confirmed = new Set<number>()
      for (const id of subjects) {
        if (await this.confirmDeleted(id, 'reconcile')) confirmed.add(id)
      }
      if (confirmed.size === 0) return
      for (const id of confirmed) {
        if (alerting.has(id)) await this.forgetAlerts(id, 'reconcile')
      }
      await this.apply(
        planDevicePrune(this.snapshot(), confirmed, this.guard()),
        'reconcile',
        (fresh) => planDevicePrune(fresh, confirmed, this.guard()),
      )
    })
  }

  /** The reload-tick door for targets. */
  reconcileTargets(): Promise<void> {
    return this.serialise(async () => {
      if (!this.ready('reconcile')) return
      const referenced = referencedTargetIds(this.snapshot())
      if (referenced.size === 0) return
      const answer = this.takeCatalog()
      if (answer === null) return
      this.catalogs = [...this.catalogs, answer].slice(-2)
      const [previous, latest] = this.catalogs
      if (previous === undefined || latest === undefined) return
      this.sayUnprunable(referenced, latest)
      const candidates = [...referenced].filter((id) => {
        const provider = this.providerOf.get(id)
        return (
          provider !== undefined &&
          !previous.ids.has(id) &&
          !latest.ids.has(id) &&
          previous.providers.has(provider) &&
          latest.providers.has(provider)
        )
      })
      if (candidates.length === 0) return
      const plan = planTargetPrune(this.snapshot(), new Set(candidates), this.guard())
      if (isEmptyPlan(plan)) return
      if (!this.withinBound('target', [...planSubjects(plan)])) return
      const deleted = new Set(candidates)
      await this.apply(plan, 'reconcile', (fresh) => planTargetPrune(fresh, deleted, this.guard()))
    })
  }

  // ── internals ──────────────────────────────────────────────────────────

  private serialise(run: () => Promise<void>, deviceId?: number): Promise<void> {
    const next = this.chain.then(run).catch((err: unknown) => {
      this.deps.logger.warn('deleted-subject prune failed', {
        ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
        meta: { error: String(err) },
      })
    })
    this.chain = next
    return next
  }

  /**
   * The disable-once guard must be able to answer before anything is written:
   * an unloaded ledger says "never disabled", and acting on that would switch
   * off a rule the operator re-enabled.
   */
  private ready(source: NcPruneSource, deviceId?: number): boolean {
    if (this.deps.ledger.isLoaded()) return true
    this.deps.logger.debug('deleted-subject prune skipped — the prune ledger has not loaded', {
      ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
      meta: { source },
    })
    return false
  }

  private async confirmDeleted(deviceId: number, source: NcPruneSource): Promise<boolean> {
    const read = this.deps.isDeviceDeleted
    if (read === undefined) {
      this.deps.logger.debug('deleted device NOT pruned — no second read is wired', {
        tags: { deviceId },
        meta: { source },
      })
      return false
    }
    try {
      if (await read(deviceId)) return true
      this.deps.logger.debug('device NOT pruned — the device manager still has its row', {
        tags: { deviceId },
        meta: { source },
      })
      return false
    } catch (err) {
      this.deps.logger.debug('device NOT pruned — the second read failed', {
        tags: { deviceId },
        meta: { source, error: String(err) },
      })
      return false
    }
  }

  /**
   * Drop a CONFIRMED-deleted device's alert rows. A failure is logged and
   * retried by the next reconcile, which still sees the row.
   */
  private async forgetAlerts(deviceId: number, source: NcPruneSource): Promise<void> {
    const alerts = this.deps.alerts
    if (alerts === undefined) return
    try {
      const forgotten = await alerts.forget(deviceId)
      if (forgotten === 0) return
      this.deps.logger.info('deleted device alerts forgotten', {
        tags: { deviceId },
        meta: { source, rows: forgotten },
      })
    } catch (err) {
      this.deps.logger.warn('deleted device alerts NOT forgotten — retried next tick', {
        tags: { deviceId },
        meta: { source, error: String(err) },
      })
    }
  }

  private withinBound(subjectKind: 'device' | 'target', subjects: readonly string[]): boolean {
    if (subjects.length <= NC_PRUNE_RECONCILE_LIMIT) {
      this.lastAbort.delete(subjectKind)
      return true
    }
    if (this.lastAbort.get(subjectKind) !== subjects.length) {
      this.lastAbort.set(subjectKind, subjects.length)
      this.deps.logger.warn(
        subjectKind === 'device'
          ? 'deleted-device reconcile aborted — too many devices missing at once'
          : 'deleted-target reconcile aborted — too many targets missing at once',
        {
          meta: {
            candidates: subjects.length,
            limit: NC_PRUNE_RECONCILE_LIMIT,
            sample: subjects.slice(0, 20).join(','),
          },
        },
      )
    }
    return false
  }

  /**
   * A referenced target missing from the latest answer that this pass can
   * NEVER prune — its provider was never seen (it was deleted before this
   * process started), or its provider is gone from the catalog (its last
   * target). Kept on the rule by design (D633); said once per process so the
   * branch is not silent.
   */
  private sayUnprunable(referenced: ReadonlySet<string>, latest: NcCatalogAnswer): void {
    for (const id of referenced) {
      if (latest.ids.has(id) || this.unprunableSaid.has(id)) continue
      const provider = this.providerOf.get(id)
      if (provider !== undefined && latest.providers.has(provider)) continue
      this.unprunableSaid.add(id)
      this.deps.logger.info('referenced target is missing but cannot be pruned', {
        meta: {
          targetId: id,
          reason: provider === undefined ? 'provider-never-seen' : 'provider-absent',
        },
      })
    }
  }

  /**
   * The cached catalog as a NEW answer, or `null`: no fresh cache, or the same
   * generation already taken. An empty catalog is never cached by the
   * dispatcher, so it can never arrive here.
   */
  private takeCatalog(): NcCatalogAnswer | null {
    const snapshot = this.deps.targetCatalog()
    if (snapshot === null || snapshot.targets.length === 0) return null
    if (snapshot.generation === this.lastCatalogGeneration) return null
    this.lastCatalogGeneration = snapshot.generation
    for (const t of snapshot.targets) this.providerOf.set(t.id, t.addonId)
    return {
      ids: new Set(snapshot.targets.map((t) => t.id)),
      providers: new Set(snapshot.targets.map((t) => t.addonId)),
    }
  }

  private guard(): (key: NcPruneGuardKey) => boolean {
    return (key) => this.deps.ledger.hasKept(key)
  }

  private snapshot(): NcPruneSnapshot {
    const panel = this.deps.alarm()
    const settings = panel?.settings()
    return {
      rules: this.writable('rule', this.deps.rules.list()),
      timelapse: this.writable('timelapse', this.deps.timelapse.list()),
      summary: this.writable('summary', this.deps.summary.list()),
      alarm:
        panel !== null && settings !== undefined
          ? {
              nonBlocking: settings.nonBlocking,
              blocking: settings.blocking,
              secureOnArmOff: settings.secureOnArmOff,
              announceTargets: settings.announceTargets,
              excluded: panel.excludedDevices(),
            }
          : null,
      mutedDeviceIds: this.deps.mutes.listMuted(),
    }
  }

  /**
   * Write a plan — from the DURABLE row, never from this node's mirror.
   *
   * The plan only says WHICH rows are affected. Each one is re-read from the
   * store immediately before its write and its edit re-planned from that fresh
   * copy: CRUD is served on any node and this mirror can be a reload tick
   * stale, and a whole-row write planned from it would revert an edit the
   * operator saved elsewhere a moment ago. A row deleted meanwhile is not
   * written back; a row the operator already fixed plans nothing. Each rule is
   * its own write: one that fails is logged and RECORDS nothing, so the next
   * tick plans it again. The ledger row is written only after the rule write.
   */
  private async apply(
    plan: NcPrunePlan,
    source: NcPruneSource,
    replan: (fresh: NcPruneSnapshot) => NcPrunePlan,
  ): Promise<void> {
    const { rules, timelapse, summary } = this.deps
    for (const planned of plan.rules) {
      await this.writeFresh(planned.notes, source, async () => {
        const fresh = await rules.reread(planned.ruleId)
        if (fresh.kind !== 'row') {
          const mirror = rules.get(planned.ruleId)
          return this.notWritten(planned.notes, fresh.kind, source, mirror?.updatedAt)
        }
        const edit = replan({ ...NO_SNAPSHOT, rules: [fresh.row] }).rules[0]
        if (edit === undefined) return []
        if (Object.keys(edit.patch).length > 0) await rules.update(edit.ruleId, edit.patch)
        return edit.notes
      })
    }
    for (const planned of plan.timelapse) {
      await this.writeFresh(planned.notes, source, async () => {
        const fresh = await timelapse.reread(planned.ruleId)
        if (fresh.kind !== 'row') {
          const mirror = timelapse.get(planned.ruleId)
          return this.notWritten(planned.notes, fresh.kind, source, mirror?.updatedAt)
        }
        const edit = replan({ ...NO_SNAPSHOT, timelapse: [fresh.row] }).timelapse[0]
        if (edit === undefined) return []
        if (Object.keys(edit.patch).length > 0) await timelapse.update(edit.ruleId, edit.patch)
        if (edit.forgetDevices.length > 0) {
          await timelapse.forgetDevices(edit.ruleId, edit.forgetDevices)
        }
        return edit.notes
      })
    }
    for (const planned of plan.summary) {
      await this.writeFresh(planned.notes, source, async () => {
        const fresh = await summary.reread(planned.ruleId)
        if (fresh.kind !== 'row') {
          const mirror = summary.get(planned.ruleId)
          return this.notWritten(planned.notes, fresh.kind, source, mirror?.updatedAt)
        }
        const edit = replan({ ...NO_SNAPSHOT, summary: [fresh.row] }).summary[0]
        if (edit === undefined) return []
        if (Object.keys(edit.patch).length > 0) await summary.update(edit.ruleId, edit.patch)
        return edit.notes
      })
    }
    if (plan.alarm !== null) await this.applyAlarm(source, replan)
    for (const deviceId of plan.unmute) {
      try {
        await this.deps.mutes.setMuted(deviceId, false)
        this.deps.logger.info('deleted device unmuted', { tags: { deviceId }, meta: { source } })
      } catch (err) {
        this.deps.logger.warn('deleted device unmute failed — retried next tick', {
          tags: { deviceId },
          meta: { source, error: String(err) },
        })
      }
    }
  }

  /** A row that vanished or no longer validates is not written — said, per subject. */
  private notWritten(
    planned: readonly NcPruneNote[],
    why: 'gone' | 'unreadable',
    source: NcPruneSource,
    mirrorUpdatedAt: number | undefined,
  ): readonly NcPruneNote[] {
    const first = planned[0]
    if (why === 'unreadable' && first !== undefined && mirrorUpdatedAt !== undefined) {
      // Remembered until the row changes: without this the same bad row is
      // re-planned (and its devices second-read) on every tick, forever.
      this.unwritable.set(`${first.kind}:${first.ruleId}`, mirrorUpdatedAt)
    }
    for (const note of planned) {
      if (why === 'gone') {
        this.deps.logger.debug('prune skipped — the rule was deleted meanwhile', {
          ...this.tagsOf(note),
          meta: { ruleId: note.ruleId, kind: note.kind, source },
        })
        continue
      }
      this.deps.logger.warn('prune skipped — the stored rule does not validate', {
        ...this.tagsOf(note),
        meta: { ruleId: note.ruleId, kind: note.kind, field: note.field, source },
      })
    }
    return []
  }

  /** Drop the rows a fresh read found unwritable, until they change. */
  private writable<TRow extends { readonly id: string; readonly updatedAt: number }>(
    kind: NcPruneKind,
    rows: readonly TRow[],
  ): readonly TRow[] {
    return rows.filter((row) => {
      const key = `${kind}:${row.id}`
      const held = this.unwritable.get(key)
      if (held === undefined) return true
      if (held === row.updatedAt) return false
      this.unwritable.delete(key)
      return true
    })
  }

  /**
   * Run one fresh write and record what it did. `planned` names the subjects
   * for the failure line only — what is RECORDED is what the fresh plan wrote.
   */
  private async writeFresh(
    planned: readonly NcPruneNote[],
    source: NcPruneSource,
    write: () => Promise<readonly NcPruneNote[]>,
  ): Promise<void> {
    let notes: readonly NcPruneNote[]
    try {
      notes = await write()
      // Stamped AFTER the rule write, so the row's `at` is never older than
      // the `updatedAt` that write gave the rule — the banner compares them.
      await this.deps.ledger.record(notes, source, this.deps.now())
    } catch (err) {
      for (const note of planned) {
        this.deps.logger.warn('notification rule prune failed — retried next tick', {
          ...this.tagsOf(note),
          meta: {
            ruleId: note.ruleId,
            kind: note.kind,
            field: note.field,
            source,
            error: String(err),
          },
        })
      }
      return
    }
    for (const note of notes) this.logNote(note, source)
  }

  /**
   * The panel's lists are re-read at the moment of the write, for the same
   * reason as the rules: the plan was made before several awaits. The panel
   * lives in this process, so its settings are the authority, not a mirror.
   */
  private async applyAlarm(
    source: NcPruneSource,
    replan: (fresh: NcPruneSnapshot) => NcPrunePlan,
  ): Promise<void> {
    const panel = this.deps.alarm()
    if (panel === null) return
    const settings = panel.settings()
    const edit = replan({
      ...NO_SNAPSHOT,
      alarm: {
        nonBlocking: settings.nonBlocking,
        blocking: settings.blocking,
        secureOnArmOff: settings.secureOnArmOff,
        announceTargets: settings.announceTargets,
        excluded: panel.excludedDevices(),
      },
    }).alarm
    if (edit === null) return
    try {
      const patch: NcAlarmSettingsPatch = {
        ...(edit.nonBlocking !== undefined ? { nonBlocking: edit.nonBlocking } : {}),
        ...(edit.blocking !== undefined ? { blocking: edit.blocking } : {}),
        ...(edit.secureOnArmOff !== undefined ? { secureOnArmOff: edit.secureOnArmOff } : {}),
        ...(edit.announceTargets !== undefined
          ? { announceTargets: [...edit.announceTargets] }
          : {}),
      }
      if (Object.keys(patch).length > 0) await panel.applySettings(patch)
      for (const deviceId of edit.forgetExcluded) panel.forgetExcluded(deviceId)
      for (const subject of edit.dropped) {
        this.deps.logger.info('deleted subject pruned from the alarm panel', {
          ...(edit.droppedKind === 'device' ? { tags: { deviceId: Number(subject) } } : {}),
          meta: { source, panelDeviceId: panel.deviceId, subject },
        })
      }
    } catch (err) {
      this.deps.logger.warn('alarm panel prune failed — retried next tick', {
        tags: { deviceId: panel.deviceId },
        meta: { source, dropped: edit.dropped.join(','), error: String(err) },
      })
    }
  }

  private tagsOf(note: NcPruneNote): NcPruneLogTags {
    return note.subjectKind === 'device' ? { tags: { deviceId: Number(note.subject) } } : {}
  }

  private logNote(note: NcPruneNote, source: NcPruneSource): void {
    const meta = {
      ruleId: note.ruleId,
      kind: note.kind,
      field: note.field,
      source,
      outcome: note.outcome,
      ...(note.subjectKind === 'target' ? { targetId: note.subject } : {}),
    }
    const what = note.subjectKind === 'device' ? 'device' : 'target'
    if (note.outcome === 'kept-disabled') {
      this.deps.logger.warn(`notification rule disabled — its last ${what} was deleted`, {
        ...this.tagsOf(note),
        meta,
      })
      return
    }
    if (note.outcome === 'kept') {
      this.deps.logger.info(`deleted ${what} kept on a notification rule that was already off`, {
        ...this.tagsOf(note),
        meta,
      })
      return
    }
    this.deps.logger.info(`deleted ${what} pruned from notification rule`, {
      ...this.tagsOf(note),
      meta,
    })
  }
}
