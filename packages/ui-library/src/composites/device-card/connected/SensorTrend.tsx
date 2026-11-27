import type { HeroMeasurementReading } from '@camstack/types'
import { type ReactElement, useMemo } from 'react'
import type { SparklinePoint } from '../../charts/Sparkline'
import { HISTORY_WINDOW_MS } from '../../device-history/history-window'
import { useHistoryReads } from '../../device-history/use-device-history'
import type { ReadingDisplaySubject } from '../../hero-model/measurement-display'
import { TrendReadoutView } from './TrendReadout'

const MINUTE_MS = 60_000

/** The fewest points a trend line is drawn from: one point is not a trend. */
export const TREND_MIN_POINTS = 2

export interface SensorTrendProps {
  readonly deviceId: number
  /** The history series (`cap:<cap>.<field>`). */
  readonly historyKey: string
  readonly label: string
  /** The series is in this reading's base unit; the tooltip converts it like the value. */
  readonly reading: HeroMeasurementReading
  /** The device, so the trend reads in the unit of the card's big value. */
  readonly subject: ReadingDisplaySubject | null
  /** A tile-sized line (a composed sensor's reading): the curve alone. */
  readonly compact?: boolean
}

/** The last day of a sensor's reading; nothing until the read answers with a line. */
export function SensorTrend({
  deviceId,
  historyKey,
  label,
  reading,
  subject,
  compact = false,
}: SensorTrendProps): ReactElement | null {
  const window = useMemo(() => {
    const to = Math.ceil(Date.now() / MINUTE_MS) * MINUTE_MS
    return { from: to - HISTORY_WINDOW_MS['24h'], to }
  }, [])
  const items = useMemo(() => [{ deviceId, key: historyKey }], [deviceId, historyKey])
  const reads = useHistoryReads(items, window, false)
  if (reads.status !== 'ok') return null
  const entry = [...reads.data.current.values()][0]
  if (entry === undefined || !entry.ok) return null
  const points: SparklinePoint[] = (entry.result.series[0]?.points ?? []).map((p) => ({
    x: p.t,
    v: p.mean ?? p.last,
  }))
  if (points.filter((p) => p.v !== null).length < TREND_MIN_POINTS) return null
  return (
    <TrendReadoutView
      testId="dc-sensor-trend"
      points={points}
      label={label}
      quantity={reading.quantity}
      subject={subject}
      currentAriaHidden
      compact={compact}
      windowMs={HISTORY_WINDOW_MS['24h']}
    />
  )
}
