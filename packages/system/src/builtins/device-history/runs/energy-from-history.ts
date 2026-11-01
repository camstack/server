/**
 * The energy of a window from device-history's OWN stored series - the
 * fallback when the meter counter could not give `end - start` (D1003).
 *
 * It sums the per-bucket `delta` of the derived energy key. Buckets are five
 * minutes wide, so a window shorter than {@link MIN_HISTORY_WINDOW_MS} is never
 * answered from them: a number built from one partial bucket would be a guess.
 */
import {
  DEVICE_HISTORY_ENERGY_KEY,
  type DeviceHistorySubject,
  type DeviceHistoryQueryResult,
} from '@camstack/types'

export const MIN_HISTORY_WINDOW_MS: number = 10 * 60_000
const MAX_POINTS = 5000

export interface EnergyHistoryQuery {
  (input: {
    readonly key: string
    readonly subject: DeviceHistorySubject
    readonly from: number
    readonly to: number
    readonly resolution: '5m'
    readonly maxPoints: number
  }): Promise<DeviceHistoryQueryResult>
}

/** kWh over `[from, to]`, or `null` when the series cannot say (no meter, no points, too short). */
export async function energyKwhFromHistory(
  query: EnergyHistoryQuery,
  deviceId: number,
  from: number,
  to: number,
): Promise<number | null> {
  if (to - from < MIN_HISTORY_WINDOW_MS) return null
  const result = await query({
    key: DEVICE_HISTORY_ENERGY_KEY,
    subject: { kind: 'device', deviceId },
    from,
    to,
    resolution: '5m',
    maxPoints: MAX_POINTS,
  })
  if (result.truncated) return null
  let total = 0
  let seen = false
  for (const series of result.series) {
    for (const point of series.points) {
      if (point.delta === null || point.t < from - 5 * 60_000 || point.t > to) continue
      total += point.delta
      seen = true
    }
  }
  return seen ? total : null
}
