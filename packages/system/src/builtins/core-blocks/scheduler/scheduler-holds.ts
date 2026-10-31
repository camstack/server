/**
 * Holds (D983): from a `hold` point until the next point of its profile, keep
 * the steps' effects true.
 *
 * One hold is live per scheduler at a time. It is derived, never remembered:
 * every reconcile asks the timeline "which hold window is `now` in?", so a hub
 * restart lands in the right window with no replay. What it keeps in memory is
 * only the per-device bookkeeping — has our write landed, did someone else
 * move it, how many re-applications are left.
 *
 *  - A write of ours is given `settleMs` to show up in the device's state; a
 *    change seen while it is pending (an `opening` cover) is ours, never manual.
 *  - A target that never reached its value in that time is DRIFT: re-applied,
 *    at most `maxHoldAttempts` times per window, then `gave-up`.
 *  - A target that was held and then changed with nothing pending of ours was
 *    moved by someone else: `respect` leaves it alone until the next point,
 *    `reassert` puts it back after `graceMs`.
 *  - Two holds on one device in different states: the higher priority holds
 *    (a tie: the one already holding), the other records `overridden`.
 *  - An `activeWhen` / condition that turns false suspends the hold, reversing
 *    nothing; it applies again when the rule is true inside the window.
 */
import { randomUUID } from 'node:crypto'
import {
  actionEffect,
  type ActionTargetResolver,
  type AutomationRunTrace,
  type AutomationStepTrace,
  type ConditionReader,
  DEFAULT_HOLD_OVERRIDE,
  DEFAULT_MAX_HOLD_ATTEMPTS,
  type HoldOverride,
  type HoldTargetStatus,
  type IScopedLogger,
  normalizeCapStep,
  resolveStepArgs,
  type Scheduler,
  type SchedulerOutcome,
  type SchedulerPoint,
  type SchedulerStatus,
  type StepDeviceTrace,
  type TimeSite,
} from '@camstack/types'
import {
  localDateIn,
  profileTimeline,
  selectProfile,
  type StateTruth,
  windowAt,
} from './scheduler-timeline.js'
import { schedulerTrace } from './scheduler-trace.js'
import type { SchedulerClock, SchedulerHost } from './scheduler-types.js'

export interface HoldDeps {
  readonly clock: SchedulerClock
  readonly host: Pick<SchedulerHost, 'invokeCap'>
  readonly targets: ActionTargetResolver
  readonly logger: IScopedLogger
  readonly settleMs: number
  readonly reader: () => ConditionReader
  readonly truth: (now: number) => StateTruth
  readonly site: () => TimeSite
  record(schedulerId: string, trace: AutomationRunTrace): Promise<void>
  /** Ask the engine to look at these schedulers again (a claim was freed or taken). */
  requestReconcile(schedulerIds: readonly string[]): void
  /** Wake the engine's single timer at `at` for this scheduler. */
  wake(schedulerId: string, at: number): void
  readonly newRunId?: () => string
}

type HoldValue = string | number | boolean

interface HoldTarget {
  readonly key: string
  readonly deviceId: number
  readonly cap: string
  readonly method: string
  readonly args: Readonly<Record<string, unknown>>
  readonly field: string
  readonly value: HoldValue
  status: HoldTargetStatus
  /** Writes of ours in this window. */
  writes: number
  /** When our last write was made, until it shows up (or is given up on). */
  pendingAt: number | null
  reassertAt: number | null
}

interface HoldRun {
  readonly key: string
  readonly schedulerId: string
  readonly profileId: string
  readonly pointId: string
  readonly windowEnd: number
  readonly maxAttempts: number
  readonly override: HoldOverride
  readonly targets: Map<string, HoldTarget>
  suspended: 'inactive' | 'condition' | null
}

interface Claim {
  readonly schedulerId: string
  readonly schedulerName: string
  readonly priority: number
  readonly value: HoldValue
}

/** What a reconcile pass wants on the record. */
interface HoldEvent {
  readonly outcome: SchedulerOutcome
  readonly reason: string
  readonly deviceId?: number
  readonly failed?: boolean
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export class HoldManager {
  private readonly runs = new Map<string, HoldRun>()
  private readonly claims = new Map<string, Claim>()
  /** Events about OTHER schedulers' holds, produced while reconciling one. */
  private readonly side: Array<{ schedulerId: string; event: HoldEvent }> = []
  private readonly newRunId: () => string

  constructor(private readonly deps: HoldDeps) {
    this.newRunId = deps.newRunId ?? randomUUID
  }

  /** The holds' devices, for the engine's state subscription. */
  watchedTargets(schedulerId: string): readonly { deviceId: number; cap: string }[] {
    const run = this.runs.get(schedulerId)
    return run === undefined
      ? []
      : [...run.targets.values()].map((t) => ({
          deviceId: t.deviceId,
          cap: t.cap,
        }))
  }

  /** A claim on this device and field by another scheduler that wins against `scheduler`. */
  claimAgainst(
    scheduler: Scheduler,
    deviceId: number,
    cap: string,
    field: string,
    value: HoldValue,
  ): string | null {
    const claim = this.claims.get(`${deviceId}|${cap}|${field}`)
    if (claim === undefined || claim.schedulerId === scheduler.id || claim.value === value) {
      return null
    }
    return claim.priority >= scheduler.priority
      ? `held by "${claim.schedulerName}" (priority ${claim.priority})`
      : null
  }

  status(scheduler: Scheduler, now: number): SchedulerStatus {
    const date = localDateIn(now, this.deps.site())
    const selection = selectProfile(scheduler, date, this.deps.truth(now))
    const run = this.runs.get(scheduler.id)
    return {
      schedulerId: scheduler.id,
      profileId: selection.profile?.id ?? null,
      hold:
        run === undefined
          ? null
          : {
              pointId: run.pointId,
              until: run.windowEnd,
              suspendedInactive: run.suspended !== null,
              targets: [...run.targets.values()].map((t) => ({
                deviceId: t.deviceId,
                cap: t.cap,
                field: t.field,
                status: t.status,
                attempts: Math.max(0, t.writes - 1),
              })),
            },
    }
  }

  /** The scheduler is gone or switched wholesale: drop its hold and free its claims. */
  end(schedulerId: string): void {
    if (this.runs.delete(schedulerId)) this.release(schedulerId)
  }

  private release(schedulerId: string): void {
    let freed = false
    for (const [key, claim] of this.claims) {
      if (claim.schedulerId === schedulerId) {
        this.claims.delete(key)
        freed = true
      }
    }
    if (!freed) return
    const waiting = [...this.runs.values()]
      .filter((r) => [...r.targets.values()].some((t) => t.status === 'overridden'))
      .map((r) => r.schedulerId)
    if (waiting.length > 0) this.deps.requestReconcile(waiting)
  }

  // ── the one entry point ────────────────────────────────────────────────

  async reconcile(scheduler: Scheduler): Promise<void> {
    const now = this.deps.clock.now()
    const site = this.deps.site()
    const truth = this.deps.truth(now)
    const events: HoldEvent[] = []
    const date = localDateIn(now, site)
    const selection = selectProfile(scheduler, date, truth)
    const entry =
      selection.profile === null
        ? null
        : windowAt(profileTimeline(selection.profile, date, site), now)
    const point = entry !== null && entry.point.mode === 'hold' ? entry.point : null
    const current = this.runs.get(scheduler.id)

    if (selection.profile === null || entry === null || point === null) {
      if (current !== undefined && selection.profile === null && current.windowEnd > now) {
        // Switched off or its rule went false: suspended, nothing reversed.
        this.suspend(scheduler, current, 'inactive', selection.idleReason ?? 'not in force', events)
      } else {
        this.end(scheduler.id)
      }
      await this.flush(scheduler, current, events)
      return
    }

    const key = `${selection.profile.id}/${point.id}/${entry.at}`
    let run = current
    if (run === undefined || run.key !== key) {
      this.end(scheduler.id)
      run = {
        key,
        schedulerId: scheduler.id,
        profileId: selection.profile.id,
        pointId: point.id,
        windowEnd: entry.until,
        maxAttempts: point.maxHoldAttempts ?? DEFAULT_MAX_HOLD_ATTEMPTS,
        override: point.override ?? DEFAULT_HOLD_OVERRIDE,
        targets: new Map(),
        suspended: null,
      }
      this.runs.set(scheduler.id, run)
      this.deps.wake(scheduler.id, entry.until)
    }

    if (!truth(point.conditions)) {
      this.suspend(scheduler, run, 'condition', 'the point conditions are false', events)
      await this.flush(scheduler, run, events)
      return
    }
    run.suspended = null

    await this.syncTargets(scheduler, run, point)
    const writes: HoldTarget[] = []
    for (const target of run.targets.values()) {
      if (this.decide(scheduler, run, target, now, events) === 'write') writes.push(target)
    }
    await Promise.all(writes.map((t) => this.write(scheduler, run, t, now, events)))
    await this.flush(scheduler, run, events)
  }

  private suspend(
    scheduler: Scheduler,
    run: HoldRun,
    why: 'inactive' | 'condition',
    reason: string,
    events: HoldEvent[],
  ): void {
    if (run.suspended === why) return
    run.suspended = why
    this.release(scheduler.id)
    events.push({
      outcome: why === 'inactive' ? 'inactive' : 'condition-false',
      reason: `hold suspended — ${reason}; nothing is reversed`,
    })
  }

  // ── targets ────────────────────────────────────────────────────────────

  /** What the point's steps mean now: a domain is resolved each time, so a new device joins the hold. */
  private async syncTargets(
    scheduler: Scheduler,
    run: HoldRun,
    point: SchedulerPoint,
  ): Promise<void> {
    const wanted = new Map<string, HoldTarget>()
    for (const step of point.steps) {
      if (step.kind !== 'cap') continue
      const normalized = normalizeCapStep(step)
      if (normalized.actionId === undefined) continue
      const resolved = resolveStepArgs(step.args ?? {}, {}, () => undefined)
      const args = isPlainRecord(resolved) ? resolved : {}
      const effect = actionEffect(normalized.actionId, args)
      if (effect === null) continue
      let deviceIds: readonly number[]
      try {
        deviceIds = (
          await this.deps.targets.resolve(
            normalized.target,
            normalized.actionId,
            {},
            {
              actionId: normalized.actionId,
              owner: `scheduler:${scheduler.id}`,
            },
          )
        ).deviceIds
      } catch (err: unknown) {
        this.deps.logger.warn('scheduler hold: a step target could not be resolved', {
          meta: {
            schedulerId: scheduler.id,
            pointId: point.id,
            error: errorMessage(err),
          },
        })
        continue
      }
      for (const deviceId of deviceIds) {
        const key = `${deviceId}|${effect.cap}|${effect.field}`
        const known = run.targets.get(key)
        wanted.set(
          key,
          known !== undefined && known.value === effect.value
            ? known
            : {
                key,
                deviceId,
                cap: step.cap,
                method: step.method,
                args,
                field: effect.field,
                value: effect.value,
                status: 'pending',
                writes: 0,
                pendingAt: null,
                reassertAt: null,
              },
        )
      }
    }
    run.targets.clear()
    for (const [key, target] of wanted) run.targets.set(key, target)
  }

  /** What to do about one target now: `write` it, or leave it. Mutates its bookkeeping. */
  private decide(
    scheduler: Scheduler,
    run: HoldRun,
    t: HoldTarget,
    now: number,
    events: HoldEvent[],
  ): 'write' | 'none' {
    const actual = this.deps.reader().read(t.deviceId, t.cap, t.field)
    if (t.status === 'gave-up') return 'none'
    if (t.status === 'suspended-manual') {
      if (t.reassertAt === null || now < t.reassertAt) return 'none'
      if (actual === t.value) {
        t.status = 'held'
        t.reassertAt = null
        t.pendingAt = null
        return 'none'
      }
      t.status = 'pending'
      t.reassertAt = null
    }
    if (actual === t.value) {
      t.pendingAt = null
      if (t.status !== 'held') {
        t.status = 'held'
        events.push({
          outcome: 'held',
          reason: `${t.cap}.${t.field} = ${String(t.value)} holds`,
          deviceId: t.deviceId,
        })
      }
      this.claim(scheduler, t)
      return 'none'
    }
    if (actual === undefined && t.status === 'held') return 'none'
    if (t.pendingAt !== null && now - t.pendingAt < this.deps.settleMs) return 'none'
    if (t.status === 'held' && t.pendingAt === null) {
      // Held, then moved, and nothing of ours was pending: someone else did it.
      t.status = 'suspended-manual'
      if (run.override.mode === 'reassert') {
        t.reassertAt = now + run.override.graceMs
        this.deps.wake(scheduler.id, t.reassertAt)
      }
      events.push({
        outcome: 'suspended-manual',
        reason:
          run.override.mode === 'respect'
            ? `changed by hand to ${String(actual)} — left alone until the next point`
            : `changed by hand to ${String(actual)} — reasserted after ${run.override.graceMs} ms`,
        deviceId: t.deviceId,
      })
      if (t.reassertAt === null || t.reassertAt > now) return 'none'
      t.status = 'pending'
      t.reassertAt = null
    }
    const wasOverridden = t.status === 'overridden'
    const lostTo = this.claimAgainst(scheduler, t.deviceId, t.cap, t.field, t.value)
    if (lostTo !== null) {
      t.status = 'overridden'
      if (!wasOverridden) {
        events.push({
          outcome: 'overridden',
          reason: lostTo,
          deviceId: t.deviceId,
        })
      }
      return 'none'
    }
    if (wasOverridden) t.status = 'pending'
    if (t.writes > 0 && t.writes - 1 >= run.maxAttempts) {
      t.status = 'gave-up'
      events.push({
        outcome: 'gave-up',
        reason: `${t.cap}.${t.field} did not reach ${String(t.value)} after ${run.maxAttempts} re-applications`,
        deviceId: t.deviceId,
        failed: true,
      })
      return 'none'
    }
    return 'write'
  }

  private async write(
    scheduler: Scheduler,
    run: HoldRun,
    t: HoldTarget,
    now: number,
    events: HoldEvent[],
  ): Promise<void> {
    this.claim(scheduler, t)
    t.writes += 1
    t.pendingAt = now
    this.deps.wake(scheduler.id, now + this.deps.settleMs)
    try {
      await this.deps.host.invokeCap({
        deviceId: t.deviceId,
        cap: t.cap,
        method: t.method,
        args: t.args,
      })
    } catch (err: unknown) {
      const message = errorMessage(err)
      this.deps.logger.warn('scheduler hold: applying a state failed', {
        tags: { deviceId: t.deviceId },
        meta: {
          schedulerId: scheduler.id,
          pointId: run.pointId,
          error: message,
        },
      })
      events.push({
        outcome: 'failed',
        reason: `${t.method} failed: ${message}`,
        deviceId: t.deviceId,
        failed: true,
      })
    }
  }

  /** Take (or keep) the claim on a target; a lower-priority claimant is displaced. */
  private claim(scheduler: Scheduler, t: HoldTarget): void {
    const current = this.claims.get(t.key)
    if (current !== undefined && current.schedulerId !== scheduler.id) {
      if (current.value === t.value) return
      if (current.priority >= scheduler.priority) return
      this.displace(current, t)
    }
    this.claims.set(t.key, {
      schedulerId: scheduler.id,
      schedulerName: scheduler.name,
      priority: scheduler.priority,
      value: t.value,
    })
  }

  private displace(loser: Claim, by: HoldTarget): void {
    const run = this.runs.get(loser.schedulerId)
    const target = run?.targets.get(by.key)
    if (target === undefined) return
    target.status = 'overridden'
    this.side.push({
      schedulerId: loser.schedulerId,
      event: {
        outcome: 'overridden',
        reason: `a higher priority hold took ${by.cap}.${by.field}`,
        deviceId: by.deviceId,
      },
    })
  }

  // ── the record ─────────────────────────────────────────────────────────

  private async flush(
    scheduler: Scheduler,
    run: HoldRun | undefined,
    events: readonly HoldEvent[],
  ): Promise<void> {
    const side = this.side.splice(0)
    await this.report(scheduler.id, run, events)
    for (const { schedulerId, event } of side) {
      await this.report(schedulerId, this.runs.get(schedulerId), [event])
    }
  }

  /** One trace per outcome and reason; the devices ride on its step. */
  private async report(
    schedulerId: string,
    run: HoldRun | undefined,
    events: readonly HoldEvent[],
  ): Promise<void> {
    const groups = new Map<string, HoldEvent[]>()
    for (const event of events) {
      const key = `${event.outcome}|${event.reason}`
      groups.set(key, [...(groups.get(key) ?? []), event])
    }
    const at = this.deps.clock.now()
    for (const group of groups.values()) {
      const first = group[0]
      if (first === undefined) continue
      const devices: StepDeviceTrace[] = group.flatMap((e) =>
        e.deviceId === undefined
          ? []
          : [
              {
                deviceId: e.deviceId,
                outcome: e.failed === true ? ('error' as const) : ('ok' as const),
                message: e.reason,
              },
            ],
      )
      const step: AutomationStepTrace = {
        path: `points.${run?.pointId ?? 'hold'}`,
        kind: 'hold',
        outcome: group.some((e) => e.failed === true) ? 'error' : 'ok',
        message: first.reason,
        ...(devices.length > 0 ? { devices } : {}),
      }
      try {
        await this.deps.record(
          schedulerId,
          schedulerTrace({
            runId: this.newRunId(),
            startedAt: at,
            endedAt: at,
            outcome: first.outcome,
            reason: first.reason,
            vars: {
              schedulerId,
              ...(run === undefined ? {} : { profileId: run.profileId, pointId: run.pointId }),
            },
            steps: [step],
          }),
        )
      } catch (err: unknown) {
        this.deps.logger.warn('scheduler hold could not be written to the runs ledger', {
          meta: { schedulerId, error: errorMessage(err) },
        })
      }
    }
  }
}
