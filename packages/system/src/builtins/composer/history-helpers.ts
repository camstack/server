/**
 * Statistics and integrals are history queries, on a schedule (D944).
 *
 * One pass at a time. A tick that lands while a pass is running is remembered
 * once and run after it — not queued without bound. A rolling window is not
 * queried faster than its cadence, even when the source samples. A truncated
 * or uncovered read keeps the last total. The slice is a cache: a new instance
 * asks history again and publishes the same number.
 */
import {
  declaredSeriesKind,
  DEFAULT_HISTORY_RETENTION,
  type DeviceHistoryQueryPoint,
  type DeviceHistoryQueryResult,
  errMsg,
  evaluateDerivative,
  evaluateStatistic,
  HISTORY_FAST_MS,
  HISTORY_SLOW_MS,
  type HistoryRetention,
  type HistoryTier,
  type HistoryValue,
  HOUR_MS,
  type HistoryHelperSpec,
  integrateReading,
  type IScopedLogger,
  MINUTE_MS,
  type ReadingQuantity,
  nextLocalMidnight,
  openReset,
  openStatistic,
  planResetTier,
  planStatisticTier,
  type SeriesPoint,
  type SeriesRead,
  statisticCadenceMs,
  type CompositionSourceRef,
} from '@camstack/types'
import { capSeriesKey } from '../device-history/capture/capture-engine.js'
import type { DeadlineTimer } from './composition-runtime.js'

const QUERY_MAX_POINTS: number = 5000

export interface HistoryQuery {
  readonly deviceId: number
  readonly key: string
  readonly from: number
  readonly to: number
  readonly resolution: HistoryTier
  readonly maxPoints: number
}

export interface SeriesWrite {
  readonly cap: string
  readonly path: string
  readonly value: number | null
}

export interface HistoryBlockView {
  readonly blockId: string
  readonly deviceId: number
  readonly helper: HistoryHelperSpec
}

export interface HistoryHelperPorts {
  readonly now: () => number
  readonly timeZone: string
  readonly logger: IScopedLogger
  readonly query: (input: HistoryQuery) => Promise<DeviceHistoryQueryResult>
  readonly retention: () => Promise<HistoryRetention>
  readonly sourceDeviceId: (ref: CompositionSourceRef) => number | null
  /**
   * The source device's `SourceInfo.quantity`, when the output is a statistic
   * or a meter (D944). Absent in tests that predate the copy: the number is
   * still published, and the chart has no unit.
   */
  readonly sourceQuantity?: (deviceId: number) => Promise<ReadingQuantity | null>
  /** Writes that quantity onto the composed device. Absent together with `sourceQuantity`. */
  readonly adoptQuantity?: (blockId: string, quantity: ReadingQuantity) => Promise<void>
  readonly blocks: () => readonly HistoryBlockView[]
  readonly publish: (blockId: string, writes: readonly SeriesWrite[]) => void
  readonly timer: DeadlineTimer
}

export class HistoryHelpers {
  private running = false
  private again = false
  private stopped = false
  private readonly lastRun = new Map<string, number>()
  private readonly noted = new Map<string, string>()

  constructor(private readonly ports: HistoryHelperPorts) {}

  start(): void {
    this.stopped = false
    if (this.ports.blocks().length === 0) {
      this.ports.timer.disarm()
      return
    }
    void this.pass()
  }

  stop(): void {
    this.stopped = true
    this.ports.timer.disarm()
  }

  /** A new sample of `deviceId`. Rolling windows wait out their cadence. */
  noteSample(deviceId: number): void {
    if (this.stopped) return
    const now = this.ports.now()
    let due: number | null = null
    for (const block of this.ports.blocks()) {
      if (block.helper.kind === 'integral' || block.helper.window.kind !== 'rolling') continue
      if (this.ports.sourceDeviceId(block.helper.source.source) !== deviceId) continue
      const next = Math.max(
        now,
        (this.lastRun.get(block.blockId) ?? 0) + statisticCadenceMs(block.helper.window),
      )
      if (due === null || next < due) due = next
    }
    if (due !== null) this.ports.timer.arm(due, () => void this.pass())
  }

  private async pass(): Promise<void> {
    if (this.stopped) return
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    let followUp = false
    try {
      const retention = await this.retention()
      for (const block of this.ports.blocks()) {
        await this.one(block, retention)
        this.lastRun.set(block.blockId, this.ports.now())
      }
    } finally {
      this.running = false
      followUp = this.again && !this.stopped
      if (followUp) this.again = false
    }
    if (followUp) {
      await this.pass()
      return
    }
    this.arm()
  }

  private async retention(): Promise<HistoryRetention> {
    try {
      return await this.ports.retention()
    } catch (err: unknown) {
      this.ports.logger.warn('history retention could not be read — the defaults stand', {
        meta: { error: errMsg(err) },
      })
      return DEFAULT_HISTORY_RETENTION
    }
  }

  private async one(block: HistoryBlockView, retention: HistoryRetention): Promise<void> {
    const helper = block.helper
    const kind = declaredSeriesKind(helper.source)
    if (kind === null || kind === 'enum') {
      this.note(block, `${helper.source.cap}.${helper.source.fieldPath} has no numeric history`)
      return
    }
    const tierPlan =
      helper.kind === 'integral'
        ? planResetTier(helper.reset, retention)
        : planStatisticTier(helper.window, retention)
    if (!tierPlan.ok) {
      this.note(block, tierPlan.reason)
      return
    }
    const range =
      helper.kind === 'integral'
        ? openReset(helper.reset, this.ports.now(), this.ports.timeZone)
        : openStatistic(helper.window, this.ports.now(), this.ports.timeZone)
    if (range === null) {
      this.note(block, `the hub timezone \`${this.ports.timeZone}\` is not a calendar`)
      return
    }
    const deviceId = this.ports.sourceDeviceId(helper.source.source)
    if (deviceId === null) {
      this.note(block, 'the source device is not resolved — the last total is kept')
      return
    }
    await this.adoptSourceQuantity(block, deviceId)
    let result: DeviceHistoryQueryResult
    try {
      result = await this.ports.query({
        deviceId,
        key: capSeriesKey(helper.source.cap, helper.source.fieldPath),
        from: range.from,
        to: range.to,
        resolution: tierPlan.tier,
        maxPoints: QUERY_MAX_POINTS,
      })
    } catch (err: unknown) {
      this.note(block, `the history query failed — the last total is kept: ${errMsg(err)}`)
      return
    }
    if (result.truncated || result.resolution !== tierPlan.tier) {
      this.note(block, 'the history query was truncated — the last total is kept')
      return
    }
    const series = result.series[0]
    if (series === undefined) {
      this.note(block, 'history returned no series — the last total is kept')
      return
    }
    const read = toRead(
      kind,
      tierPlan.tier,
      range.from,
      range.to,
      series.before,
      series.points,
      this.ports.timeZone,
    )
    const answer = answerOf(helper, read)
    if (answer.write === 'hold') {
      this.note(block, answer.reason ?? 'the history answer was held')
      return
    }
    if (answer.excluded > 0 && answer.reason !== null) this.note(block, answer.reason)
    else this.noted.delete(block.blockId)
    this.ports.publish(block.blockId, writesFor(helper, answer))
  }

  private async adoptSourceQuantity(
    block: HistoryBlockView,
    sourceDeviceId: number,
  ): Promise<void> {
    if (!inheritsSourceQuantity(block.helper)) return
    const read = this.ports.sourceQuantity
    const adopt = this.ports.adoptQuantity
    if (read === undefined || adopt === undefined) return
    let quantity: ReadingQuantity | null
    try {
      quantity = await read(sourceDeviceId)
    } catch (err: unknown) {
      this.ports.logger.warn('the source quantity could not be read — the chart has no unit', {
        tags: { deviceId: block.deviceId },
        meta: { blockId: block.blockId, sourceDeviceId, error: errMsg(err) },
      })
      return
    }
    if (quantity === null) return
    try {
      await adopt(block.blockId, quantity)
    } catch (err: unknown) {
      this.ports.logger.warn('the composed device did not keep the source quantity', {
        tags: { deviceId: block.deviceId },
        meta: { blockId: block.blockId, error: errMsg(err) },
      })
    }
  }

  private note(block: HistoryBlockView, reason: string): void {
    if (this.noted.get(block.blockId) === reason) return
    this.noted.set(block.blockId, reason)
    this.ports.logger.warn(reason, {
      tags: { deviceId: block.deviceId },
      meta: { blockId: block.blockId },
    })
  }

  private arm(): void {
    if (this.stopped || this.ports.blocks().length === 0) {
      this.ports.timer.disarm()
      return
    }
    const now = this.ports.now()
    let at = now + cadenceFloor(this.ports.blocks())
    const midnight = nextLocalMidnight(now, this.ports.timeZone)
    if (midnight !== null && midnight < at) at = midnight
    this.ports.timer.arm(Math.max(at, now), () => void this.pass())
  }
}

function answerOf(helper: HistoryHelperSpec, read: SeriesRead): HistoryValue {
  switch (helper.kind) {
    case 'statistic':
      return evaluateStatistic(helper.stat, read)
    case 'derivative':
      return evaluateDerivative(read, PER_MS[helper.per])
    case 'integral':
      return integrateReading(read, helper.output === 'energy' ? 'energy-kwh' : 'per-second')
  }
}

const PER_MS: Readonly<Record<'second' | 'minute' | 'hour', number>> = {
  second: 1000,
  minute: MINUTE_MS,
  hour: HOUR_MS,
}

/** A rate of a temperature is not a temperature: only a statistic and a meter keep the unit. */
function inheritsSourceQuantity(helper: HistoryHelperSpec): boolean {
  return helper.kind === 'statistic' || (helper.kind === 'integral' && helper.output === 'meter')
}

function cadenceFloor(blocks: readonly HistoryBlockView[]): number {
  let ms = HISTORY_SLOW_MS
  for (const block of blocks) {
    const cadence =
      block.helper.kind === 'integral'
        ? block.helper.reset === 'daily'
          ? HISTORY_FAST_MS
          : HISTORY_SLOW_MS
        : statisticCadenceMs(block.helper.window)
    if (cadence < ms) ms = cadence
  }
  return ms
}

function writesFor(helper: HistoryHelperSpec, answer: HistoryValue): readonly SeriesWrite[] {
  const output =
    helper.kind !== 'integral'
      ? { cap: 'numeric-sensor', path: 'value' }
      : helper.output === 'energy'
        ? { cap: 'power-meter', path: 'energy' }
        : { cap: 'meter', path: 'value' }
  const total = answer.included + answer.excluded
  return [
    { cap: output.cap, path: output.path, value: answer.value },
    { cap: 'group-status', path: 'included', value: answer.included },
    { cap: 'group-status', path: 'excluded', value: answer.excluded },
    { cap: 'group-status', path: 'total', value: total },
  ]
}

function toRead(
  kind: 'gauge' | 'counter' | 'boolean',
  tier: HistoryTier,
  from: number,
  to: number,
  before: { readonly t: number; readonly value: number | null } | null,
  points: readonly DeviceHistoryQueryPoint[],
  timeZone: string,
): SeriesRead {
  return {
    kind,
    tier,
    from,
    to,
    before: before === null ? null : { t: before.t, value: before.value },
    truncated: false,
    points: points.map((point) => toPoint(point, tier, to, timeZone)),
  }
}

function toPoint(
  point: DeviceHistoryQueryPoint,
  tier: HistoryTier,
  to: number,
  timeZone: string,
): SeriesPoint {
  return {
    t: point.t,
    value: point.last,
    twMean: point.twMean,
    twMs: tier === 'raw' ? null : bucketMs(tier, point.t, to, timeZone),
    min: point.min,
    max: point.max,
    last: point.last,
    delta: point.delta,
  }
}

function bucketMs(tier: HistoryTier, t: number, to: number, timeZone: string): number {
  const end =
    tier === '1d' ? nextLocalMidnight(t, timeZone) : t + (tier === '5m' ? 5 * MINUTE_MS : HOUR_MS)
  if (end === null) return 0
  return Math.max(0, Math.min(end, to) - t)
}
