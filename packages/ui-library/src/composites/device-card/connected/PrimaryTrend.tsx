import { type ReactElement, useMemo } from 'react'
import { useDeviceManagerGetBindings } from '../../../generated/system-hooks'
import { HISTORY_WINDOW_MS } from '../../device-history/history-window'
import { useHistoryReads } from '../../device-history/use-device-history'
import { useCardDisplaySubject } from '../../hero-model/card-display-subject'
import { pickPrimaryTrend, primaryTrendKeys } from './primary-trend'
import { TrendReadoutView } from './TrendReadout'

const MINUTE_MS = 60_000

export interface PrimaryTrendProps {
  readonly deviceId: number
  readonly label: string
}

/**
 * The last day of the device's primary series: the one the highest-priority ENABLED cap
 * declares and that has data. Nothing until the bindings and the read answered with a line.
 */
export function PrimaryTrend({ deviceId, label }: PrimaryTrendProps): ReactElement | null {
  const subject = useCardDisplaySubject()
  const bindings = useDeviceManagerGetBindings({ deviceId }, { staleTime: 30_000 })
  const enabledCaps = useMemo(
    () => (bindings.data?.entries ?? []).map((entry) => entry.capName),
    [bindings.data],
  )
  const window = useMemo(() => {
    const to = Math.ceil(Date.now() / MINUTE_MS) * MINUTE_MS
    return { from: to - HISTORY_WINDOW_MS['24h'], to }
  }, [])
  const items = useMemo(
    () => primaryTrendKeys(enabledCaps).map((key) => ({ deviceId, key })),
    [deviceId, enabledCaps],
  )
  const reads = useHistoryReads(items, window, false)
  if (reads.status !== 'ok') return null
  const trend = pickPrimaryTrend({
    deviceId,
    enabledCaps,
    reads: reads.data.current,
  })
  if (trend === null) return null
  return (
    <TrendReadoutView
      testId="dc-primary-trend"
      points={trend.points}
      label={label}
      quantity={trend.quantity}
      unit={trend.unit}
      subject={subject}
      windowMs={HISTORY_WINDOW_MS['24h']}
    />
  )
}
