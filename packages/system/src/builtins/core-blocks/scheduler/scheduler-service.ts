/**
 * The `schedulers` surface (D983): authoring, preview, conflicts and status of
 * the operator's schedulers. The engine runs them; this file validates what
 * is saved, tells the engine to look again, and answers the editor.
 *
 * A save is refused with a reason (`[invalid-scheduler] …`) — a hold with a
 * step that leads to no state, a sun point on a site with no location — never
 * stored as a point that would silently do nothing.
 */
import {
  actionEffect,
  type ActionTargetResolver,
  type AutomationRunTrace,
  type ISchedulersProvider,
  type IScopedLogger,
  normalizeActionUnits,
  normalizeCapStep,
  QuantityUnitError,
  type Scheduler,
  type SchedulerConflict,
  SchedulerError,
  type SchedulerInput,
  type SchedulerPreview,
  type SchedulerPreviewPoint,
  type SchedulerStatus,
  validateSchedulerInput,
  type UnitResolver,
  type WeekdayKey,
  weekdayOfLocalDate,
  resolveStepArgs,
} from '@camstack/types'
import { type RunsLedger, schedulerOwner } from '../runs-ledger.js'
import type { SchedulerEngine } from './scheduler-engine.js'
import type { SchedulersStore } from './scheduler-store.js'
import {
  addLocalDays,
  localDateIn,
  profileTimeline,
  selectProfile,
  startOfLocalDay,
  timeSiteOf,
} from './scheduler-timeline.js'
import type { SchedulerHost } from './scheduler-types.js'

export interface SchedulersServiceDeps {
  readonly store: SchedulersStore
  readonly engine: SchedulerEngine
  readonly ledger: RunsLedger
  readonly host: Pick<SchedulerHost, 'readSite'>
  readonly targets: ActionTargetResolver
  readonly units: UnitResolver
  readonly logger: IScopedLogger
  readonly now?: () => number
}

type Value = string | number | boolean

interface HeldEffect {
  readonly deviceId: number
  readonly cap: string
  readonly field: string
  readonly value: Value
}

interface HoldWindow {
  readonly profileId: string
  readonly pointId: string
  readonly from: number
  readonly until: number
  readonly effects: readonly HeldEffect[]
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export class SchedulersService implements ISchedulersProvider {
  private readonly now: () => number

  constructor(private readonly deps: SchedulersServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  async list(): Promise<Scheduler[]> {
    return this.deps.store.list()
  }

  async get(input: { schedulerId: string }): Promise<{ scheduler: Scheduler | null }> {
    return { scheduler: await this.deps.store.get(input.schedulerId) }
  }

  // ── authoring ──────────────────────────────────────────────────────────

  /** Units and targets in the stored shape, then the author-time rules. Throws a typed refusal. */
  private async prepare(input: SchedulerInput): Promise<SchedulerInput> {
    let profiles: SchedulerInput['profiles']
    try {
      profiles = input.profiles.map((profile) => ({
        ...profile,
        points: profile.points.map((point) => ({
          ...point,
          steps: normalizeActionUnits(point.steps, this.deps.units).value,
        })),
      }))
    } catch (err: unknown) {
      if (err instanceof QuantityUnitError) {
        this.deps.logger.warn('scheduler save refused — a unit does not fit its quantity', {
          meta: { scheduler: input.name, error: err.message },
        })
        throw new SchedulerError('invalid-scheduler', err.message)
      }
      throw err
    }
    const prepared: SchedulerInput = { ...input, profiles }
    const reading = await this.deps.host.readSite()
    const verdict = validateSchedulerInput(prepared, reading)
    if (!verdict.ok) {
      const message = verdict.issues.map((i) => `${i.path}: ${i.message}`).join('; ')
      this.deps.logger.warn('scheduler save refused', {
        meta: { scheduler: input.name, message },
      })
      throw new SchedulerError('invalid-scheduler', message)
    }
    return prepared
  }

  async create(input: { scheduler: SchedulerInput }): Promise<{ scheduler: Scheduler }> {
    const prepared = await this.prepare(input.scheduler)
    const scheduler = await this.deps.store.create(prepared)
    this.deps.logger.info('scheduler created', {
      meta: { schedulerId: scheduler.id, name: scheduler.name },
    })
    await this.deps.engine.reload()
    return { scheduler }
  }

  async update(input: {
    schedulerId: string
    scheduler: SchedulerInput
  }): Promise<{ scheduler: Scheduler }> {
    const prepared = await this.prepare(input.scheduler)
    const scheduler = await this.deps.store.update(input.schedulerId, prepared)
    this.deps.logger.info('scheduler updated', {
      meta: { schedulerId: scheduler.id },
    })
    await this.deps.engine.reload()
    return { scheduler }
  }

  async delete(input: { schedulerId: string }): Promise<void> {
    const removed = await this.deps.store.delete(input.schedulerId)
    if (!removed) throw new SchedulerError('not-found', `no scheduler "${input.schedulerId}"`)
    await this.deps.ledger.delete(schedulerOwner(input.schedulerId))
    this.deps.logger.info('scheduler deleted', {
      meta: { schedulerId: input.schedulerId },
    })
    await this.deps.engine.reload()
  }

  async setEnabled(input: {
    schedulerId: string
    profileId?: string | undefined
    enabled: boolean
  }): Promise<{ scheduler: Scheduler }> {
    const existing = await this.deps.store.get(input.schedulerId)
    if (existing === null) {
      throw new SchedulerError('not-found', `no scheduler "${input.schedulerId}"`)
    }
    const { id: _id, createdAt: _c, updatedAt: _u, ...body } = existing
    let next: SchedulerInput
    if (input.profileId === undefined) {
      next = { ...body, enabled: input.enabled }
    } else {
      if (!existing.profiles.some((p) => p.id === input.profileId)) {
        throw new SchedulerError(
          'not-found',
          `no profile "${input.profileId}" in "${existing.name}"`,
        )
      }
      next = {
        ...body,
        profiles: existing.profiles.map((p) =>
          p.id === input.profileId ? { ...p, enabled: input.enabled } : p,
        ),
      }
    }
    // Switching is not an edit of the timeline: it is stored as-is, without the save rules
    // (a scheduler saved before the site lost its location must still be switchable off).
    const scheduler = await this.deps.store.update(input.schedulerId, next)
    this.deps.logger.info('scheduler switched', {
      meta: {
        schedulerId: scheduler.id,
        profileId: input.profileId ?? null,
        enabled: input.enabled,
      },
    })
    await this.deps.engine.reload()
    return { scheduler }
  }

  // ── reads ──────────────────────────────────────────────────────────────

  async preview(input: {
    schedulerId: string
    date?: string | undefined
  }): Promise<SchedulerPreview> {
    const scheduler = await this.deps.store.get(input.schedulerId)
    if (scheduler === null)
      throw new SchedulerError('not-found', `no scheduler "${input.schedulerId}"`)
    const reading = await this.deps.host.readSite()
    const site = timeSiteOf(reading)
    const date = input.date ?? localDateIn(this.now(), site)
    if (addLocalDays(date, 0) !== date) {
      throw new SchedulerError('invalid-date', `"${date}" is not a calendar date`)
    }
    const selection = selectProfile(scheduler, date, this.deps.engine.truth())
    const points: SchedulerPreviewPoint[] = []
    if (selection.profile !== null) {
      const timeline = profileTimeline(selection.profile, date, site)
      for (const point of selection.profile.points) {
        const entry = timeline.find((e) => e.point.id === point.id)
        points.push({
          pointId: point.id,
          mode: point.mode,
          at: entry?.at ?? null,
          until: point.mode === 'hold' ? (entry?.until ?? null) : null,
          stepCount: point.steps.length,
        })
      }
      points.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))
    }
    return {
      schedulerId: scheduler.id,
      date,
      timeZone: reading.timeZone,
      idleReason: selection.idleReason,
      profileId: selection.profile?.id ?? null,
      points,
    }
  }

  async conflicts(input: {
    scheduler: SchedulerInput
    schedulerId?: string | undefined
  }): Promise<{ conflicts: SchedulerConflict[] }> {
    const reading = await this.deps.host.readSite()
    const site = timeSiteOf(reading)
    const others = (await this.deps.store.list()).filter(
      (o) => o.id !== input.schedulerId && o.enabled,
    )
    const today = localDateIn(this.now(), site)
    const dates = Array.from({ length: 7 }, (_, i) => addLocalDays(today, i))
    const mine = await this.holdWindows(input.scheduler, dates, site)
    const found = new Map<string, SchedulerConflict>()
    for (const other of others) {
      const theirs = await this.holdWindows(other, dates, site)
      for (const [date, myWindows] of mine) {
        for (const a of myWindows) {
          for (const b of theirs.get(date) ?? []) {
            const from = Math.max(a.from, b.from)
            const until = Math.min(a.until, b.until)
            if (from >= until) continue
            for (const ea of a.effects) {
              for (const eb of b.effects) {
                if (ea.deviceId !== eb.deviceId || ea.cap !== eb.cap || ea.field !== eb.field)
                  continue
                if (ea.value === eb.value) continue
                const key = `${a.pointId}|${other.id}|${b.pointId}|${ea.deviceId}|${ea.field}`
                if (found.has(key)) continue
                const dayStart = startOfLocalDay(date, site)
                found.set(key, {
                  deviceId: ea.deviceId,
                  cap: ea.cap,
                  field: ea.field,
                  mine: {
                    profileId: a.profileId,
                    pointId: a.pointId,
                    value: ea.value,
                    priority: input.scheduler.priority,
                  },
                  other: {
                    schedulerId: other.id,
                    schedulerName: other.name,
                    profileId: b.profileId,
                    pointId: b.pointId,
                    value: eb.value,
                    priority: other.priority,
                  },
                  fromMinute: Math.max(0, Math.round((from - dayStart) / 60_000)),
                  toMinute: Math.min(1440, Math.round((until - dayStart) / 60_000)),
                  winner:
                    input.scheduler.priority > other.priority
                      ? 'mine'
                      : input.scheduler.priority < other.priority
                        ? 'other'
                        : 'tie',
                })
              }
            }
          }
        }
      }
    }
    return { conflicts: [...found.values()] }
  }

  /** The hold windows of each date in `dates`, with the device states they hold. */
  private async holdWindows(
    scheduler: SchedulerInput,
    dates: readonly string[],
    site: ReturnType<typeof timeSiteOf>,
  ): Promise<Map<string, HoldWindow[]>> {
    const effectsOf = new Map<string, readonly HeldEffect[]>()
    for (const profile of scheduler.profiles) {
      for (const point of profile.points) {
        if (point.mode !== 'hold') continue
        const effects: HeldEffect[] = []
        for (const step of point.steps) {
          if (step.kind !== 'cap') continue
          const normalized = normalizeCapStep(step)
          if (normalized.actionId === undefined) continue
          const resolved = resolveStepArgs(step.args ?? {}, {}, () => undefined)
          const effect = actionEffect(normalized.actionId, isPlainRecord(resolved) ? resolved : {})
          if (effect === null) continue
          try {
            const { deviceIds } = await this.deps.targets.resolve(
              normalized.target,
              normalized.actionId,
              {},
              {
                actionId: normalized.actionId,
                owner: 'scheduler-conflicts',
              },
            )
            for (const deviceId of deviceIds) {
              effects.push({
                deviceId,
                cap: effect.cap,
                field: effect.field,
                value: effect.value,
              })
            }
          } catch (err: unknown) {
            this.deps.logger.warn('scheduler conflicts: a step target could not be resolved', {
              meta: {
                pointId: point.id,
                error: err instanceof Error ? err.message : String(err),
              },
            })
          }
        }
        effectsOf.set(`${profile.id}/${point.id}`, effects)
      }
    }
    const out = new Map<string, HoldWindow[]>()
    for (const date of dates) {
      const weekday: WeekdayKey = weekdayOfLocalDate(date)
      const windows: HoldWindow[] = []
      for (const profile of scheduler.profiles) {
        if (!profile.enabled || !profile.days.includes(weekday)) continue
        for (const entry of profileTimeline(profile, date, site)) {
          if (entry.point.mode !== 'hold') continue
          windows.push({
            profileId: profile.id,
            pointId: entry.point.id,
            from: entry.at,
            until: entry.until,
            effects: effectsOf.get(`${profile.id}/${entry.point.id}`) ?? [],
          })
        }
      }
      out.set(date, windows)
    }
    return out
  }

  async getStatus(): Promise<SchedulerStatus[]> {
    return this.deps.engine.status()
  }

  async getTraces(input: { schedulerId: string }): Promise<{ traces: AutomationRunTrace[] }> {
    const view = await this.deps.ledger.get(schedulerOwner(input.schedulerId))
    return { traces: [...view.traces] }
  }
}
