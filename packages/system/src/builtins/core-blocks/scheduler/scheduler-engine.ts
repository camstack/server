/**
 * The scheduler engine (D983), on the hub.
 *
 * **One timer.** Every future moment the engine must act at — a point's next
 * occurrence, the end of a hold window, a settle or grace deadline — is an
 * entry of ONE time-ordered queue, and ONE timer is armed for its head. There
 * is no timer per point and no polling: a hold wakes on the state-mirror
 * changes of the devices it targets and of the facts its rules read.
 *
 * **Time is derived, not replayed.** An `edge` is processed when its entry
 * falls due. After a hub restart the queue is rebuilt from the scheduler's
 * `processedUntil` stamp, so a point that fell due while the hub was down is
 * simply an entry already due: it runs when it is late by less than
 * `maxLateMs` and is recorded `missed` otherwise. A hold has no missed state:
 * `reconcile` asks the timeline which window `now` is in.
 *
 * Everything that changes engine state runs on one promise chain, so a state
 * event and a timer never interleave.
 */
import { randomUUID } from 'node:crypto'
import {
  type ActionTargetResolver,
  actionEffect,
  type AutomationRunTrace,
  buildActionSteps,
  type CapCall,
  collectWhenMirrorSources,
  ConditionMirror,
  evaluateWhenTree,
  type IScopedLogger,
  type MirrorSource,
  nextOccurrence,
  normalizeCapStep,
  type Scheduler,
  type SchedulerOutcome,
  type SchedulerPoint,
  type SchedulerProfile,
  type SchedulerStatus,
  type SiteReading,
  runSteps,
  type TimeSite,
  vocabActionIdFor,
  type AutomationWhen,
} from '@camstack/types'
import { HoldManager } from './scheduler-holds.js'
import type { SchedulersStore } from './scheduler-store.js'
import { localDateIn, profileState, type StateTruth, timeSiteOf } from './scheduler-timeline.js'
import { schedulerTrace } from './scheduler-trace.js'
import {
  createRealClock,
  DEFAULT_SETTLE_MS,
  MAX_CATCHUP_MS,
  type SchedulerClock,
  type SchedulerHost,
} from './scheduler-types.js'

/** The longest a single `setTimeout` can wait. */
const MAX_TIMER_MS = 2_147_000_000
/** The ring a scheduler keeps in the runs ledger. */
export const SCHEDULER_TRACE_KEEP = 50

export type QueueEntry =
  | {
      readonly kind: 'point'
      readonly at: number
      readonly schedulerId: string
      readonly profileId: string
      readonly pointId: string
    }
  | {
      readonly kind: 'wake'
      readonly at: number
      readonly schedulerId: string
    }

export interface SchedulerEngineDeps {
  readonly store: SchedulersStore
  readonly host: SchedulerHost
  readonly targets: ActionTargetResolver
  readonly logger: IScopedLogger
  /** Write one trace to the owner's ring in the runs ledger. */
  record(schedulerId: string, trace: AutomationRunTrace): Promise<void>
  readonly clock?: SchedulerClock
  readonly settleMs?: number
  readonly newRunId?: () => string
}

/** An edge step refused because a higher priority hold has the device. */
class OverriddenError extends Error {}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class SchedulerEngine {
  private readonly clock: SchedulerClock
  private readonly holds: HoldManager
  private readonly newRunId: () => string
  private queue: QueueEntry[] = []
  private timer: unknown = null
  private chain: Promise<void> = Promise.resolve()
  private schedulers: Scheduler[] = []
  private reading: SiteReading = { location: null, timeZone: 'UTC' }
  private site: TimeSite = timeSiteOf({ location: null, timeZone: 'UTC' })
  private mirror = new ConditionMirror([])
  /** `deviceId|cap` → the schedulers that read it. */
  private watchers = new Map<string, Set<string>>()
  private dirty = new Set<string>()
  private reconcileQueued = false
  private siteKnown = false
  private disposed = false

  constructor(private readonly deps: SchedulerEngineDeps) {
    this.clock = deps.clock ?? createRealClock()
    this.newRunId = deps.newRunId ?? randomUUID
    this.holds = new HoldManager({
      clock: this.clock,
      host: deps.host,
      targets: deps.targets,
      logger: deps.logger.child('holds'),
      settleMs: deps.settleMs ?? DEFAULT_SETTLE_MS,
      reader: () => this.mirror,
      truth: (now) => this.truthAt(now),
      site: () => this.site,
      record: (id, trace) => deps.record(id, trace),
      requestReconcile: (ids) => this.requestReconcile(ids),
      wake: (id, at) => this.insert({ kind: 'wake', at, schedulerId: id }),
      ...(deps.newRunId === undefined ? {} : { newRunId: deps.newRunId }),
    })
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  /**
   * Load, place every point on the queue, and reconcile the holds to the window
   * `now` is in. `false` when the site cannot be read yet (the hub is still
   * booting): nothing is armed, because a wall-clock time read in a guessed zone
   * would fire at the wrong hour — the caller tries again.
   */
  async start(): Promise<boolean> {
    let started = false
    await this.serial(async () => {
      try {
        await this.load()
      } catch (err: unknown) {
        this.deps.logger.warn('scheduler: not started — the site cannot be read yet', {
          meta: { error: errorMessage(err) },
        })
        return
      }
      await this.rebuildMirror()
      await this.rebuildQueue()
      this.markAllDirty()
      await this.drain() // points that fell due while the hub was down run (or are `missed`) now
      started = true
    })
    return started
  }

  /** The schedulers changed (create / update / delete / switch): read them again. */
  reload(): Promise<void> {
    return this.serial(async () => {
      await this.load()
      await this.rebuildMirror()
      await this.rebuildQueue()
      for (const s of this.holdSchedulerIdsGone()) this.holds.end(s)
      this.markAllDirty()
      await this.drain()
    })
  }

  /** A device was added, removed, moved or re-bound: the domains are stale. */
  invalidateTargets(): void {
    this.deps.targets.invalidate()
    void this.serial(async () => {
      await this.rebuildMirror()
      this.markAllDirty()
      await this.settle()
    })
  }

  /** A `device.state-changed` event: feed the mirror, wake whoever reads that slice. */
  onDeviceState(deviceId: number, cap: string, slice: unknown): void {
    if (this.disposed) return
    this.mirror.apply(deviceId, cap, slice)
    const readers = this.watchers.get(`${deviceId}|${cap}`)
    if (readers !== undefined) this.requestReconcile([...readers])
  }

  /** Whether a state tree holds right now (a rule with no tree is true). */
  truth(): StateTruth {
    return this.truthAt(this.clock.now())
  }

  /** Resolves when everything queued so far has been processed. */
  idle(): Promise<void> {
    return this.chain
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) this.clock.clearTimer(this.timer)
    this.timer = null
    this.queue = []
  }

  /** The entries waiting, soonest first (a spec reads it; the cap does not). */
  pending(): readonly QueueEntry[] {
    return this.queue
  }

  status(): SchedulerStatus[] {
    const now = this.clock.now()
    return this.schedulers.map((s) => this.holds.status(s, now))
  }

  // ── plumbing ───────────────────────────────────────────────────────────

  private serial(work: () => Promise<void>): Promise<void> {
    const next = this.chain.then(work).catch((err: unknown) => {
      this.deps.logger.error('scheduler engine step failed', {
        meta: { error: errorMessage(err) },
      })
    })
    this.chain = next
    return next
  }

  private requestReconcile(ids: readonly string[]): void {
    if (this.disposed) return
    for (const id of ids) this.dirty.add(id)
    if (this.reconcileQueued) return
    this.reconcileQueued = true
    void this.serial(async () => {
      this.reconcileQueued = false
      await this.settle()
    })
  }

  private markAllDirty(): void {
    for (const s of this.schedulers) this.dirty.add(s.id)
  }

  private holdSchedulerIdsGone(): string[] {
    const live = new Set(this.schedulers.map((s) => s.id))
    return this.status()
      .map((st) => st.schedulerId)
      .filter((id) => !live.has(id))
  }

  private async load(): Promise<void> {
    this.schedulers = await this.deps.store.list()
    try {
      this.reading = await this.deps.host.readSite()
      this.site = timeSiteOf(this.reading)
      this.siteKnown = true
    } catch (err: unknown) {
      if (!this.siteKnown) throw err
      this.deps.logger.warn('scheduler: the site could not be read — keeping the last one', {
        meta: { error: errorMessage(err) },
      })
    }
  }

  private truthAt(now: number): StateTruth {
    return (when: AutomationWhen | undefined) =>
      when === undefined || evaluateWhenTree(when, this.mirror, now).pass
  }

  // ── the mirror ─────────────────────────────────────────────────────────

  /** Every (device, cap) a scheduler's rules or holds read, so state events can wake it. */
  private async rebuildMirror(): Promise<void> {
    const sources = new Map<string, MirrorSource>()
    const watchers = new Map<string, Set<string>>()
    const add = (schedulerId: string, source: MirrorSource): void => {
      const key =
        source.kind === 'device'
          ? `d|${source.deviceId}|${source.cap}`
          : `s|${source.stableId}|${source.cap}`
      sources.set(key, source)
      if (source.kind === 'device') {
        const wk = `${source.deviceId}|${source.cap}`
        watchers.set(wk, (watchers.get(wk) ?? new Set()).add(schedulerId))
      }
    }
    for (const s of this.schedulers) {
      if (!s.enabled) continue
      for (const src of collectWhenMirrorSources(s.activeWhen)) add(s.id, src)
      for (const profile of s.profiles) {
        for (const src of collectWhenMirrorSources(profile.activeWhen)) add(s.id, src)
        for (const point of profile.points) {
          for (const src of collectWhenMirrorSources(point.conditions)) add(s.id, src)
          if (point.mode !== 'hold') continue
          for (const src of await this.holdSources(s, point)) add(s.id, src)
        }
      }
    }
    this.mirror = new ConditionMirror([...sources.values()])
    this.watchers = watchers
    const report = await this.mirror.refresh({
      fetchSlice: (deviceId, cap) => this.deps.host.fetchSlice(deviceId, cap),
      fetchStableIds: () => this.deps.host.fetchStableIds(),
    })
    if (report.kept > 0) {
      this.deps.logger.debug('scheduler mirror kept stale values for sources it could not read', {
        meta: { ...report },
      })
    }
  }

  private async holdSources(s: Scheduler, point: SchedulerPoint): Promise<MirrorSource[]> {
    const out: MirrorSource[] = []
    for (const step of point.steps) {
      if (step.kind !== 'cap') continue
      const normalized = normalizeCapStep(step)
      if (normalized.actionId === undefined) continue
      const effect = actionEffect(normalized.actionId, step.args)
      if (effect === null) continue
      try {
        const resolved = await this.deps.targets.resolve(
          normalized.target,
          normalized.actionId,
          {},
          {
            actionId: normalized.actionId,
            owner: `scheduler:${s.id}`,
          },
        )
        for (const deviceId of resolved.deviceIds) {
          out.push({ kind: 'device', deviceId, cap: effect.cap })
        }
      } catch (err: unknown) {
        this.deps.logger.warn('scheduler: a hold target could not be resolved', {
          meta: {
            schedulerId: s.id,
            pointId: point.id,
            error: errorMessage(err),
          },
        })
      }
    }
    return out
  }

  // ── the queue and the one timer ────────────────────────────────────────

  private insert(entry: QueueEntry): void {
    if (this.disposed) return
    if (
      entry.kind === 'wake' &&
      this.queue.some(
        (e) => e.kind === 'wake' && e.schedulerId === entry.schedulerId && e.at === entry.at,
      )
    ) {
      return
    }
    const index = this.queue.findIndex((e) => e.at > entry.at)
    this.queue.splice(index === -1 ? this.queue.length : index, 0, entry)
    this.arm()
  }

  private arm(): void {
    if (this.timer !== null) this.clock.clearTimer(this.timer)
    this.timer = null
    const head = this.queue[0]
    if (head === undefined || this.disposed) return
    const delay = Math.min(Math.max(0, head.at - this.clock.now()), MAX_TIMER_MS)
    this.timer = this.clock.setTimer(() => {
      this.timer = null
      void this.serial(() => this.drain())
    }, delay)
  }

  /** The next occurrence of every enabled point, counted from where each scheduler was last processed. */
  private async rebuildQueue(): Promise<void> {
    this.queue = []
    const now = this.clock.now()
    for (const s of this.schedulers) {
      if (!s.enabled) continue
      const stamp = await this.deps.store.processedUntil(s.id)
      const from = Math.max(stamp ?? now, now - MAX_CATCHUP_MS)
      for (const profile of s.profiles) {
        if (!profile.enabled) continue
        for (const point of profile.points) {
          const at = nextOccurrence(point.at, from, this.site, {
            days: profile.days,
          })
          if (at !== null) {
            this.queue.push({
              kind: 'point',
              at,
              schedulerId: s.id,
              profileId: profile.id,
              pointId: point.id,
            })
          }
        }
      }
    }
    this.queue.sort((a, b) => a.at - b.at)
    this.arm()
  }

  /** Everything due, in time order, then the holds. */
  private async drain(): Promise<void> {
    for (;;) {
      const head = this.queue[0]
      if (head === undefined || head.at > this.clock.now()) break
      this.queue.shift()
      this.dirty.add(head.schedulerId)
      if (head.kind === 'point') await this.handlePoint(head)
    }
    await this.settle()
  }

  private async settle(): Promise<void> {
    for (let guard = 0; this.dirty.size > 0 && guard < 20; guard += 1) {
      const ids = [...this.dirty]
      this.dirty.clear()
      for (const id of ids) {
        const s = this.schedulers.find((x) => x.id === id)
        if (s === undefined) this.holds.end(id)
        else await this.holds.reconcile(s)
      }
    }
    this.arm()
  }

  // ── points ─────────────────────────────────────────────────────────────

  private async handlePoint(entry: Extract<QueueEntry, { kind: 'point' }>): Promise<void> {
    const scheduler = this.schedulers.find((s) => s.id === entry.schedulerId)
    const profile = scheduler?.profiles.find((p) => p.id === entry.profileId)
    const point = profile?.points.find((p) => p.id === entry.pointId)
    if (scheduler === undefined || profile === undefined || point === undefined) return
    const next = nextOccurrence(point.at, entry.at, this.site, {
      days: profile.days,
    })
    if (next !== null) this.insert({ ...entry, at: next })
    try {
      await this.deps.store.setProcessedUntil(scheduler.id, entry.at)
    } catch (err: unknown) {
      this.deps.logger.warn('scheduler: the processed-until stamp could not be written', {
        meta: { schedulerId: scheduler.id, error: errorMessage(err) },
      })
    }
    if (point.mode !== 'edge') return
    await this.runEdge(scheduler, profile, point, entry.at)
  }

  private async runEdge(
    scheduler: Scheduler,
    profile: SchedulerProfile,
    point: SchedulerPoint,
    at: number,
  ): Promise<void> {
    const now = this.clock.now()
    const truth = this.truthAt(now)
    const vars = {
      schedulerId: scheduler.id,
      profileId: profile.id,
      pointId: point.id,
      at,
    }
    const state = profileState(scheduler, profile, localDateIn(at, this.site), truth)
    if (state === 'scheduler-inactive' || state === 'profile-inactive') {
      await this.say(
        scheduler.id,
        'inactive',
        `skipped — ${state === 'scheduler-inactive' ? 'the scheduler' : 'the profile'} is not active (its condition is false)`,
        vars,
        now,
      )
      return
    }
    if (state !== 'in-force') {
      this.deps.logger.debug('scheduler edge ignored — its profile is not in force', {
        meta: { ...vars, state },
      })
      return
    }
    const late = now - at
    if (late >= scheduler.maxLateMs) {
      await this.say(
        scheduler.id,
        'missed',
        `missed — ${late} ms late, the limit is ${scheduler.maxLateMs} ms`,
        vars,
        now,
      )
      return
    }
    if (!truth(point.conditions)) {
      await this.say(
        scheduler.id,
        'condition-false',
        'skipped — the point conditions are false',
        vars,
        now,
      )
      return
    }
    await this.performEdge(scheduler, point, vars, now)
  }

  private async performEdge(
    scheduler: Scheduler,
    point: SchedulerPoint,
    vars: Readonly<Record<string, number | string>>,
    startedAt: number,
  ): Promise<void> {
    let overridden = 0
    let failedCalls = 0
    const invokeCap = async (call: CapCall): Promise<void> => {
      const refusal = this.edgeRefusal(scheduler, call)
      if (refusal !== null) {
        overridden += 1
        throw new OverriddenError(refusal)
      }
      try {
        await this.deps.host.invokeCap(call)
      } catch (err: unknown) {
        failedCalls += 1
        throw err
      }
    }
    let outcome: SchedulerOutcome = 'failed'
    let reason = 'the run failed'
    let steps: Awaited<ReturnType<typeof runSteps>>['steps'] = []
    try {
      const runnable = buildActionSteps(
        point.steps,
        {},
        {
          invokeCap,
          sleep: (ms) =>
            new Promise<void>((resolve) => {
              this.clock.setTimer(resolve, ms)
            }),
          resolveTarget: (target, actionId, v, origin) =>
            this.deps.targets.resolve(target, actionId, v, origin),
          owner: `scheduler:${scheduler.id}`,
          onMissingVar: () => undefined,
        },
      )
      const result = await runSteps(runnable, {
        pathPrefix: 'steps',
        isAborted: () => this.disposed,
        abortReason: 'the engine was stopped',
        now: () => this.clock.now(),
        onFailure: (failure) => {
          this.deps.logger.warn('scheduler edge step failed — stopping the sequence', {
            ...(failure.deviceId === undefined ? {} : { tags: { deviceId: failure.deviceId } }),
            meta: { ...vars, step: failure.index, error: failure.message },
          })
        },
      })
      steps = result.steps
      const failure = result.steps.find((s) => s.outcome === 'error')
      if (!result.failed) {
        outcome = 'done'
        reason = 'ran'
      } else {
        outcome = overridden > 0 && failedCalls === 0 ? 'overridden' : 'failed'
        reason = failure?.message ?? 'the run failed'
      }
    } catch (err: unknown) {
      reason = errorMessage(err)
      this.deps.logger.error('scheduler edge crashed', {
        meta: { ...vars, error: reason },
      })
    }
    await this.deps
      .record(
        scheduler.id,
        schedulerTrace({
          runId: this.newRunId(),
          startedAt,
          endedAt: this.clock.now(),
          outcome,
          reason,
          vars,
          steps,
        }),
      )
      .catch((err: unknown) => {
        this.deps.logger.warn('scheduler run could not be written to the runs ledger', {
          meta: { ...vars, error: errorMessage(err) },
        })
      })
  }

  /** A device call that a higher priority hold has, in a different state. */
  private edgeRefusal(scheduler: Scheduler, call: CapCall): string | null {
    const actionId = vocabActionIdFor(call.cap, call.method, call.args)
    if (actionId === undefined) return null
    const effect = actionEffect(actionId, call.args)
    if (effect === null) return null
    return this.holds.claimAgainst(scheduler, call.deviceId, effect.cap, effect.field, effect.value)
  }

  private async say(
    schedulerId: string,
    outcome: SchedulerOutcome,
    reason: string,
    vars: Readonly<Record<string, number | string>>,
    at: number,
  ): Promise<void> {
    await this.deps
      .record(
        schedulerId,
        schedulerTrace({
          runId: this.newRunId(),
          startedAt: at,
          endedAt: at,
          outcome,
          reason,
          vars,
        }),
      )
      .catch((err: unknown) => {
        this.deps.logger.warn('scheduler outcome could not be written to the runs ledger', {
          meta: { ...vars, error: errorMessage(err) },
        })
      })
  }
}
