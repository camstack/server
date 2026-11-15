import { type ReactElement, useMemo } from 'react'
import { useUnitPreferences } from '../../../contexts/unit-preferences'
import { useDeviceManagerGetBindings } from '../../../generated/system-hooks'
import { preferenceForQuantity } from '../../../lib/unit-preferences'
import { Sparkline } from '../../charts/Sparkline'
import { HISTORY_WINDOW_MS } from '../../device-history/history-window'
import { useHistoryReads } from '../../device-history/use-device-history'
import { pickPrimaryTrend, primaryTrendKeys } from './primary-trend'

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
  const unitPreferences = useUnitPreferences()
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
  const trend = pickPrimaryTrend({ deviceId, enabledCaps, reads: reads.data.current })
  if (trend === null) return null
  return (
    <span data-testid="dc-primary-trend" className="flex justify-center">
      <Sparkline
        points={[...trend.points]}
        ariaLabel={label}
        token="primary"
        {...(trend.quantity === undefined
          ? {}
          : {
              quantity: trend.quantity,
              displayPreference: preferenceForQuantity(unitPreferences, trend.quantity),
            })}
        zeroBased={false}
        height={36}
        widthClassName="w-48 @lg:w-64"
      />
    </span>
  )
}
