/**
 * The run recorder (D1003): turns the `running-state` flips of a device into one
 * durable `device-runs` row per run.
 *
 *  - open: `running` false -> true writes the OPEN row through, so a run that
 *    outlives this process is on disk from its first instant;
 *  - close: true -> false closes it, with the energy of the run and its outcome;
 *  - boot reconcile: the open rows are compared with the live snapshots - a
 *    device still running keeps its row, one that stopped while nobody watched
 *    closes `unknown`, one running with no row opens late. A run is never
 *    duplicated: a device has at most one open run, in the mirror and on disk.
 *
 * Nothing one-shot gates on a fallible read (D49): a failed load or snapshot
 * read changes nothing and the next pass tries again; events that arrive before
 * the first answered load wait in a bounded buffer and replay after it.
 *
 * Energy comes from device-history's own data: the meter counter at open minus
 * the counter at close, else the stored history of the window. Both unknown is
 * `null` - never `0`.
 */
import {
  type ApplianceRunDetail,
  type DeviceRun,
  type DeviceRunEnergyMethod,
  type DeviceRunOutcome,
  type DeviceRunSource,
  DeviceType,
  EventCategory,
  type IScopedLogger,
  type RecordKindHandle,
} from '@camstack/types'
import type { SnapshotMap } from '../capture/capture-engine.js'
import { isSlice, numberField, type Slice, stringField, booleanField } from './slice-readers.js'
import { MIN_HISTORY_WINDOW_MS } from './energy-from-history.js'

export const RUNNING_STATE_CAP = 'running-state'
export const POWER_METER_CAP = 'power-meter'
export const DISHWASHER_CAP = 'dishwasher'

/** A run shorter than this that never reported a finishing phase is a dwell flap, not a cycle. */
export const ABORTED_BELOW_MS: number = 2 * 60_000
/** Events held before the first answered load; beyond it the oldest are dropped, counted and logged. */
export const MAX_BUFFERED_EVENTS = 2000
export const RECORDER_TICK_MS: number = 60_000
export const RECONCILE_EVERY_TICKS = 5
export const FLUSH_EVERY_TICKS = 5

const APPLIANCE_TYPES: ReadonlySet<DeviceType> = new Set<DeviceType>([
  DeviceType.Washer,
  DeviceType.Dryer,
  DeviceType.Dishwasher,
])

export interface RunRecorderDeps {
  readonly runs: RecordKindHandle<DeviceRun>
  readonly readSnapshots: () => Promise<SnapshotMap>
  readonly readCapSlice: (deviceId: number, capName: string) => Promise<Slice | null>
  readonly deviceTypeOf: (deviceId: number) => Promise<DeviceType | undefined>
  /** kWh of a window from the stored history, or `null`. */
  readonly energyFromHistory: (deviceId: number, from: number, to: number) => Promise<number | null>
  readonly emit: (category: EventCategory, run: DeviceRun) => void
  readonly logger: IScopedLogger
  readonly clock: () => number
}

interface PowerAccumulator {
  lastAt: number
  lastW: number | null
  /** Sum of watts * milliseconds. */
  weightedWms: number
  observedMs: number
  peakW: number | null
}

interface OpenRun {
  run: DeviceRun
  readonly power: PowerAccumulator
  dirty: boolean
}

interface BufferedState {
  readonly deviceId: number
  readonly capName: string
  readonly slice: Slice
  readonly at: number
}

function runIdOf(deviceId: number, startedAt: number): string {
  return `${deviceId}:${startedAt}`
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function applianceDetailOf(run: DeviceRun): ApplianceRunDetail {
  return run.detail
}

export class RunRecorder {
  private readonly open = new Map<number, OpenRun>()
  private readonly lastEnergy = new Map<number, number>()
  private readonly lastPower = new Map<number, number>()
  private readonly lastDishwasher = new Map<number, Slice>()
  private readonly chains = new Map<number, Promise<void>>()
  private buffered: BufferedState[] = []
  private loaded = false
  private droppedWhileBuffering = 0
  private ticks = 0

  constructor(private readonly deps: RunRecorderDeps) {}

  /**
   * One minute of the owner's clock: retry the load until it answers, then
   * compare against the snapshots every {@link RECONCILE_EVERY_TICKS} and save
   * the open totals every {@link FLUSH_EVERY_TICKS}.
   */
  async tick(): Promise<void> {
    this.ticks += 1
    if (!this.loaded || this.ticks % RECONCILE_EVERY_TICKS === 0) await this.reconcile()
    if (this.ticks % FLUSH_EVERY_TICKS === 0) await this.flushOpen()
  }

  /** Has a load of the open rows ANSWERED? Until then flips are buffered. */
  isLoaded(): boolean {
    return this.loaded
  }

  /** Resolves when every queued flip has been handled (specs, shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.chains.values()])
  }

  /** The open run of a device, from the mirror. */
  openRunOf(deviceId: number): DeviceRun | null {
    return this.open.get(deviceId)?.run ?? null
  }

  // ── the stream ─────────────────────────────────────────────────────

  /** Feed one `DeviceStateChanged` slice. Never throws; a failure is logged with the device. */
  handleState(deviceId: number, capName: string, slice: Slice, at: number): void {
    if (
      capName !== RUNNING_STATE_CAP &&
      capName !== POWER_METER_CAP &&
      capName !== DISHWASHER_CAP
    ) {
      return
    }
    if (!this.loaded) {
      this.buffer({ deviceId, capName, slice, at })
      return
    }
    void this.enqueue(deviceId, () => this.apply(deviceId, capName, slice, at))
  }

  private buffer(entry: BufferedState): void {
    this.buffered.push(entry)
    if (this.buffered.length > MAX_BUFFERED_EVENTS) {
      this.buffered = this.buffered.slice(this.buffered.length - MAX_BUFFERED_EVENTS)
      this.droppedWhileBuffering += 1
    }
  }

  private enqueue(deviceId: number, work: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(deviceId) ?? Promise.resolve()
    const next = previous
      .then(work)
      .catch((err: unknown) => {
        this.deps.logger.warn('device-runs: a flip could not be recorded', {
          tags: { deviceId },
          meta: { error: errorText(err) },
        })
      })
      .finally(() => {
        if (this.chains.get(deviceId) === next) this.chains.delete(deviceId)
      })
    this.chains.set(deviceId, next)
    return next
  }

  private async apply(deviceId: number, capName: string, slice: Slice, at: number): Promise<void> {
    if (capName === POWER_METER_CAP) {
      this.notePower(deviceId, slice, at)
      return
    }
    if (capName === DISHWASHER_CAP) {
      this.lastDishwasher.set(deviceId, slice)
      return
    }
    const type = await this.deps.deviceTypeOf(deviceId)
    if (type === undefined || !APPLIANCE_TYPES.has(type)) return
    const running = booleanField(slice, 'running')
    if (running === null) return
    const held = this.open.get(deviceId)
    const since = numberField(slice, 'since') ?? at
    if (running && held === undefined) {
      await this.openRun(deviceId, since, 'running-state', slice, at)
    } else if (!running && held !== undefined) {
      await this.closeRun(deviceId, held, since, 'running-state', slice)
    } else if (running && held !== undefined) {
      this.notePhase(held, slice, at)
    }
  }

  // ── power and energy ───────────────────────────────────────────────

  private notePower(deviceId: number, slice: Slice, at: number): void {
    const energy = numberField(slice, 'energy')
    if (energy !== null) this.lastEnergy.set(deviceId, energy)
    const power = numberField(slice, 'power')
    if (power !== null) this.lastPower.set(deviceId, power)
    const held = this.open.get(deviceId)
    if (held === undefined || power === null) return
    this.accrue(held.power, at)
    held.power.lastW = power
    held.power.peakW = held.power.peakW === null ? power : Math.max(held.power.peakW, power)
    held.dirty = true
  }

  /** Close the interval since the previous reading at the watts it held. */
  private accrue(acc: PowerAccumulator, to: number): void {
    if (acc.lastW !== null && to > acc.lastAt) {
      const ms = to - acc.lastAt
      acc.weightedWms += acc.lastW * ms
      acc.observedMs += ms
    }
    acc.lastAt = Math.max(acc.lastAt, to)
  }

  private powerOf(open: OpenRun): {
    peakW: number | null
    avgW: number | null
    observedMs: number
  } {
    const { power } = open
    return {
      peakW: power.peakW,
      avgW: power.observedMs > 0 ? power.weightedWms / power.observedMs : null,
      observedMs: power.observedMs,
    }
  }

  private async energyNow(deviceId: number): Promise<number | null> {
    const seen = this.lastEnergy.get(deviceId)
    if (seen !== undefined) return seen
    try {
      return numberField(await this.deps.readCapSlice(deviceId, POWER_METER_CAP), 'energy')
    } catch (err) {
      this.deps.logger.warn('device-runs: the meter could not be read', {
        tags: { deviceId },
        meta: { error: errorText(err) },
      })
      return null
    }
  }

  private async measureEnergy(
    deviceId: number,
    detail: ApplianceRunDetail,
    startedAt: number,
    endedAt: number,
  ): Promise<{ kwh: number | null; method: DeviceRunEnergyMethod | null }> {
    const end = await this.energyNow(deviceId)
    if (detail.energyStartKwh !== null && end !== null && end >= detail.energyStartKwh) {
      return { kwh: end - detail.energyStartKwh, method: 'counter-delta' }
    }
    // No usable counter pair (no meter at open, or a reset: the counter fell).
    if (endedAt - startedAt >= MIN_HISTORY_WINDOW_MS) {
      try {
        const kwh = await this.deps.energyFromHistory(deviceId, startedAt, endedAt)
        if (kwh !== null) return { kwh, method: 'history-integral' }
      } catch (err) {
        this.deps.logger.warn('device-runs: the stored energy could not be read', {
          tags: { deviceId },
          meta: { error: errorText(err) },
        })
      }
    }
    return { kwh: null, method: null }
  }

  // ── open / close ───────────────────────────────────────────────────

  private notePhase(open: OpenRun, slice: Slice, at: number): void {
    const phase = stringField(slice, 'phase')
    if (phase === null) return
    const last = open.run.phases[open.run.phases.length - 1]
    if (last?.phase === phase) return
    open.run = { ...open.run, phases: [...open.run.phases, { phase, at }] }
    open.dirty = true
  }

  private async openRun(
    deviceId: number,
    startedAt: number,
    source: DeviceRunSource,
    slice: Slice,
    now: number,
    energyStartKwh?: number | null,
  ): Promise<void> {
    const dishwasher = this.lastDishwasher.get(deviceId) ?? null
    const phase = stringField(slice, 'phase')
    const sliceSource = stringField(slice, 'source')
    const power = this.lastPower.get(deviceId)
    const detail: ApplianceRunDetail = {
      kind: 'appliance',
      energyKwh: null,
      energyMethod: null,
      peakW: power ?? null,
      avgW: null,
      program: stringField(dishwasher, 'program'),
      remainingAtStartSec: numberField(dishwasher, 'remaining'),
      finalPhase: null,
      energyStartKwh:
        energyStartKwh !== undefined ? energyStartKwh : await this.energyNow(deviceId),
      powerObservedMs: 0,
    }
    const run: DeviceRun = {
      runId: runIdOf(deviceId, startedAt),
      deviceId,
      kind: 'appliance',
      state: 'open',
      startedAt,
      endedAt: null,
      durationMs: null,
      outcome: null,
      startSource: source,
      endSource: null,
      runningSource: sliceSource === 'native' || sliceSource === 'assigned' ? sliceSource : null,
      phases: phase === null ? [] : [{ phase, at: startedAt }],
      detail,
    }
    await this.deps.runs.put({ id: run.runId, deviceId, at: startedAt, data: run })
    this.open.set(deviceId, {
      run,
      dirty: false,
      power: {
        lastAt: Math.max(startedAt, now),
        lastW: power ?? null,
        weightedWms: 0,
        observedMs: 0,
        peakW: power ?? null,
      },
    })
    this.deps.logger.info('device-runs: a run opened', {
      tags: { deviceId },
      meta: { runId: run.runId, source },
    })
    this.announce(EventCategory.DeviceRunOpened, run)
  }

  private async closeRun(
    deviceId: number,
    held: OpenRun,
    rawEndedAt: number,
    source: DeviceRunSource,
    slice: Slice,
  ): Promise<void> {
    const { run } = held
    const endedAt = Math.max(rawEndedAt, run.startedAt)
    this.accrue(held.power, endedAt)
    const measured = this.powerOf(held)
    const detail = applianceDetailOf(run)
    const energy = await this.measureEnergy(deviceId, detail, run.startedAt, endedAt)
    const phase = stringField(slice, 'phase')
    const phases =
      phase !== null && run.phases[run.phases.length - 1]?.phase !== phase
        ? [...run.phases, { phase, at: endedAt }]
        : run.phases
    const durationMs = endedAt - run.startedAt
    const closed: DeviceRun = {
      ...run,
      state: 'closed',
      endedAt,
      durationMs,
      outcome: this.outcomeOf(
        deviceId,
        source,
        durationMs,
        phases.map((p) => p.phase),
      ),
      endSource: source,
      phases,
      detail: {
        ...detail,
        energyKwh: energy.kwh,
        energyMethod: energy.method,
        peakW: measured.peakW,
        avgW: measured.avgW,
        powerObservedMs: measured.observedMs,
        finalPhase: phases[phases.length - 1]?.phase ?? null,
      },
    }
    await this.deps.runs.put({ id: closed.runId, deviceId, at: closed.startedAt, data: closed })
    this.open.delete(deviceId)
    this.deps.logger.info('device-runs: a run closed', {
      tags: { deviceId },
      meta: {
        runId: closed.runId,
        outcome: closed.outcome,
        durationMs,
        energyKwh: energy.kwh,
        energyMethod: energy.method,
        source,
      },
    })
    this.announce(EventCategory.DeviceRunClosed, closed)
  }

  private outcomeOf(
    deviceId: number,
    source: DeviceRunSource,
    durationMs: number,
    phases: readonly string[],
  ): DeviceRunOutcome {
    if (source === 'reconcile') return 'unknown'
    if (stringField(this.lastDishwasher.get(deviceId) ?? null, 'state') === 'error') return 'error'
    const finished = phases.some((p) => /finish/i.test(p))
    return durationMs < ABORTED_BELOW_MS && !finished ? 'aborted' : 'completed'
  }

  private announce(category: EventCategory, run: DeviceRun): void {
    try {
      this.deps.emit(category, run)
    } catch (err) {
      this.deps.logger.warn('device-runs: the run event was not emitted', {
        tags: { deviceId: run.deviceId },
        meta: { category, error: errorText(err) },
      })
    }
  }

  // ── persistence of the running totals ──────────────────────────────

  /**
   * Write the power totals of every open run (a crash then loses at most one
   * interval of peak/mean, never the run). Timer-driven; a failed write leaves
   * the run dirty for the next pass.
   */
  async flushOpen(): Promise<void> {
    const now = this.deps.clock()
    for (const [deviceId, held] of this.open) {
      if (!held.dirty) continue
      this.accrue(held.power, now)
      const measured = this.powerOf(held)
      try {
        await this.deps.runs.patch(held.run.runId, {
          phases: held.run.phases,
          detail: {
            peakW: measured.peakW,
            avgW: measured.avgW,
            powerObservedMs: measured.observedMs,
          },
        })
        held.dirty = false
      } catch (err) {
        this.deps.logger.warn('device-runs: the open run totals were not saved', {
          tags: { deviceId },
          meta: { runId: held.run.runId, error: errorText(err) },
        })
      }
    }
  }

  // ── boot reconcile ─────────────────────────────────────────────────

  /**
   * Compare the open rows on disk with the live snapshots. Returns `false` when
   * either read failed - nothing changed and the caller tries again (D49).
   * Only the FIRST answered pass reads the rows (the mirror is the truth after
   * it) and replays the flips buffered while it was pending; later passes
   * compare the mirror with the snapshots, so a row read a moment before a
   * close can never bring a closed run back.
   */
  async reconcile(): Promise<boolean> {
    let rows: readonly DeviceRun[] = []
    let snapshots: SnapshotMap
    try {
      if (!this.loaded) rows = await this.loadOpenRows()
      snapshots = await this.deps.readSnapshots()
    } catch (err) {
      this.deps.logger.warn('device-runs: reconcile read failed - nothing changed', {
        meta: { error: errorText(err) },
      })
      return false
    }
    await this.settleAgainst(rows, snapshots)
    if (!this.loaded) {
      this.loaded = true
      const replay = this.buffered
      this.buffered = []
      if (this.droppedWhileBuffering > 0) {
        this.deps.logger.warn('device-runs: flips were dropped while the load was pending', {
          meta: { dropped: this.droppedWhileBuffering },
        })
        this.droppedWhileBuffering = 0
      }
      for (const entry of replay) {
        this.handleState(entry.deviceId, entry.capName, entry.slice, entry.at)
      }
    }
    return true
  }

  private async loadOpenRows(): Promise<readonly DeviceRun[]> {
    const out: DeviceRun[] = []
    let cursor: string | undefined
    do {
      const page = await this.deps.runs.query({
        where: { state: 'open' },
        limit: 500,
        ...(cursor !== undefined ? { cursor } : {}),
      })
      for (const row of page.records) out.push(row.data)
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    return out
  }

  private async settleAgainst(rows: readonly DeviceRun[], snapshots: SnapshotMap): Promise<void> {
    const now = this.deps.clock()
    const newest = new Map<number, DeviceRun>()
    // The newest open row per device is the run; an older one (a lost close) closes stale.
    for (const row of rows.toSorted((a, b) => a.startedAt - b.startedAt)) {
      const earlier = newest.get(row.deviceId)
      if (earlier !== undefined) {
        await this.exclusive(earlier.deviceId, async () => {
          await this.closeRun(earlier.deviceId, this.adopt(earlier), now, 'reconcile', {})
        })
      }
      newest.set(row.deviceId, row)
    }
    for (const row of newest.values()) {
      await this.exclusive(row.deviceId, async () => {
        this.seedPower(row.deviceId, snapshots[String(row.deviceId)]?.[POWER_METER_CAP])
        const held = this.adopt(row)
        const slice = runningSliceOf(snapshots, row.deviceId)
        if (booleanField(slice, 'running') !== false) return
        const since = numberField(slice, 'since')
        await this.closeRun(
          row.deviceId,
          held,
          since !== null && since > row.startedAt ? since : now,
          'reconcile',
          slice ?? {},
        )
      })
    }
    await this.settleMirror(snapshots, now)
    await this.openLate(snapshots, now)
  }

  /** A mirrored run whose device now says it stopped closes `unknown` (a later pass, flips missed). */
  private async settleMirror(snapshots: SnapshotMap, now: number): Promise<void> {
    for (const [deviceId, held] of [...this.open]) {
      const slice = runningSliceOf(snapshots, deviceId)
      if (booleanField(slice, 'running') !== false) continue
      const since = numberField(slice, 'since')
      await this.exclusive(deviceId, async () => {
        const current = this.open.get(deviceId)
        if (current === undefined || current.run.runId !== held.run.runId) return
        await this.closeRun(
          deviceId,
          current,
          since !== null && since > held.run.startedAt ? since : now,
          'reconcile',
          slice ?? {},
        )
      })
    }
  }

  /** A device running with no open run: open it late, from its own `since`. */
  private async openLate(snapshots: SnapshotMap, now: number): Promise<void> {
    for (const [key, caps] of Object.entries(snapshots)) {
      const deviceId = Number(key)
      if (!Number.isInteger(deviceId)) continue
      const slice = caps[RUNNING_STATE_CAP]
      if (!isSlice(slice) || booleanField(slice, 'running') !== true) continue
      await this.exclusive(deviceId, async () => {
        if (this.open.has(deviceId)) return
        const type = await this.deps.deviceTypeOf(deviceId)
        if (type === undefined || !APPLIANCE_TYPES.has(type)) return
        this.seedPower(deviceId, caps[POWER_METER_CAP])
        // Opened late: the counter at the true start is unknown, so the stored history answers at close.
        await this.openRun(
          deviceId,
          numberField(slice, 'since') ?? now,
          'reconcile',
          slice,
          now,
          null,
        )
      })
    }
  }

  /** One device at a time; a failure is logged with the device and never aborts the pass. */
  private exclusive(deviceId: number, work: () => Promise<void>): Promise<void> {
    return this.enqueue(deviceId, work)
  }

  private seedPower(deviceId: number, slice: unknown): void {
    if (!isSlice(slice)) return
    const energy = numberField(slice, 'energy')
    if (energy !== null && !this.lastEnergy.has(deviceId)) this.lastEnergy.set(deviceId, energy)
    const power = numberField(slice, 'power')
    if (power !== null && !this.lastPower.has(deviceId)) this.lastPower.set(deviceId, power)
  }

  /** Put a stored open row back in the mirror, its power totals resumed from the row. */
  private adopt(row: DeviceRun): OpenRun {
    const existing = this.open.get(row.deviceId)
    if (existing !== undefined) return existing
    const detail = applianceDetailOf(row)
    const held: OpenRun = {
      run: row,
      dirty: false,
      power: {
        lastAt: this.deps.clock(),
        lastW: this.lastPower.get(row.deviceId) ?? null,
        weightedWms: (detail.avgW ?? 0) * detail.powerObservedMs,
        observedMs: detail.powerObservedMs,
        peakW: detail.peakW,
      },
    }
    this.open.set(row.deviceId, held)
    return held
  }
}

function runningSliceOf(snapshots: SnapshotMap, deviceId: number): Slice | null {
  const slice = snapshots[String(deviceId)]?.[RUNNING_STATE_CAP]
  return isSlice(slice) ? slice : null
}
