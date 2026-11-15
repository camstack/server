import {
  type DeviceHistoryQueryManyEntry,
  HISTORY_CATALOG,
  HISTORY_PRIMARY,
  pickPrimarySeriesKey,
  primarySeriesKey,
  quantityFromUnit,
  type ReadingQuantity,
} from '@camstack/types'
import type { SparklinePoint } from '../../charts/Sparkline'
import { readItemId } from '../../device-history/use-device-history'

/** The fewest points a trend line is drawn from: one point is not a trend. */
const MIN_POINTS = 2

export interface PrimaryTrend {
  readonly key: string
  readonly points: readonly SparklinePoint[]
  /** The declared quantity of the series; `undefined` when the cap states no known unit. */
  readonly quantity: ReadingQuantity | undefined
}

/** The series keys worth reading for a device: the declared primary of each enabled cap. */
export function primaryTrendKeys(enabledCaps: readonly string[]): readonly string[] {
  return enabledCaps.flatMap((cap) => {
    const key = primarySeriesKey(cap)
    return key === null ? [] : [key]
  })
}

function pointsOf(entry: DeviceHistoryQueryManyEntry | undefined): readonly SparklinePoint[] {
  if (entry === undefined || !entry.ok) return []
  return (entry.result.series[0]?.points ?? []).map((p) => ({ x: p.t, v: p.mean ?? p.last }))
}

function hasLine(points: readonly SparklinePoint[]): boolean {
  return points.filter((p) => p.v !== null).length >= MIN_POINTS
}

function quantityOfKey(enabledCaps: readonly string[], key: string): ReadingQuantity | undefined {
  const cap = enabledCaps.find((c) => primarySeriesKey(c) === key)
  const primary = cap === undefined ? undefined : HISTORY_PRIMARY[cap]
  const unit =
    cap === undefined || primary === undefined
      ? undefined
      : HISTORY_CATALOG[cap]?.[primary.field]?.unit
  return quantityFromUnit(unit)
}

/**
 * The trend a device card draws: the primary series of the enabled cap with the highest
 * priority that answered with a line, else the next. `null` when none did.
 */
export function pickPrimaryTrend(input: {
  readonly deviceId: number
  readonly enabledCaps: readonly string[]
  readonly reads: ReadonlyMap<string, DeviceHistoryQueryManyEntry>
}): PrimaryTrend | null {
  const pointsFor = (key: string) =>
    pointsOf(input.reads.get(readItemId({ deviceId: input.deviceId, key })))
  const key = pickPrimarySeriesKey({
    enabledCaps: input.enabledCaps,
    hasData: (k) => hasLine(pointsFor(k)),
  })
  if (key === null) return null
  return { key, points: pointsFor(key), quantity: quantityOfKey(input.enabledCaps, key) }
}
