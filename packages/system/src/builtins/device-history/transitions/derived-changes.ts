/**
 * The device's own changes, read back from device-history (D1084). The audited fields are the
 * ones a vocabulary action effect names (`auditedFields`); a field with a history block has a
 * raw series, a field without one has none and no derived row: a documented blind spot.
 *
 * What this module knows of history is one port (`ChangeSeriesPort`), so the read is specified
 * without a store. Boolean and enum series are change-only; a gauge is as dense as its capture
 * interval, and the burst rule (`change-coalescing.ts`) nets it to one change per field.
 */
import type { DeviceHistoryKind, TransitionValue } from '@camstack/types'
import {
  coalesceChanges,
  fieldKey,
  type FieldChange,
  type FieldPoint,
} from './change-coalescing.js'

/** One audited field of a device that has a raw series. */
export interface AuditedSeries {
  readonly capName: string
  readonly field: string
  readonly kind: DeviceHistoryKind
}

/** One raw point of a series: the stored ordinal or number, and its state name for an enum. */
export interface RawChangePoint {
  readonly t: number
  readonly value: number | null
  readonly state: string | null
}

export interface RawChangeRead {
  /** The newest point before the window; `null` when the series had none. */
  readonly before: RawChangePoint | null
  /** Oldest first. */
  readonly points: readonly RawChangePoint[]
}

/** What the reader needs of device-history. */
export interface ChangeSeriesPort {
  /** The audited fields of `deviceId` that have a series. */
  auditedSeries(deviceId: number): readonly AuditedSeries[]
  readRaw(deviceId: number, series: AuditedSeries, from: number, to: number): Promise<RawChangeRead>
}

export interface DerivedWindow {
  readonly from: number
  readonly to: number
  readonly capName?: string | undefined
}

/** The most raw points read for one series; the newest are kept past it. */
export const DERIVED_POINTS_MAX = 10_000

function valueOf(kind: DeviceHistoryKind, point: RawChangePoint): TransitionValue | undefined {
  if (kind === 'enum') return point.state ?? undefined
  if (point.value === null) return undefined
  if (kind === 'boolean') return point.value !== 0
  if (kind === 'gauge') return point.value
  return undefined
}

export class DerivedChanges {
  constructor(
    private readonly port: ChangeSeriesPort,
    private readonly clock: () => number,
  ) {}

  /** The settled changes of the device's audited fields in `window`, newest first. */
  async read(deviceId: number, window: DerivedWindow): Promise<readonly FieldChange[]> {
    const series = this.port
      .auditedSeries(deviceId)
      .filter((s) => s.kind !== 'counter')
      .filter((s) => window.capName === undefined || s.capName === window.capName)
    const points: FieldPoint[] = []
    const before = new Map<string, TransitionValue>()
    for (const s of series) {
      const read = await this.port.readRaw(deviceId, s, window.from, window.to)
      if (read.before !== null) {
        const prior = valueOf(s.kind, read.before)
        if (prior !== undefined) before.set(fieldKey(s.capName, s.field), prior)
      }
      for (const p of read.points) {
        const value = valueOf(s.kind, p)
        if (value !== undefined) points.push({ capName: s.capName, field: s.field, at: p.t, value })
      }
    }
    return coalesceChanges({ points, before, now: this.clock() })
  }
}
