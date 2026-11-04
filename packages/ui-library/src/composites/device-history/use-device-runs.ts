/**
 * A device's runs for the History view. `device-runs` is a per-type
 * capability: a device without it, or with no run yet, answers an error or an
 * empty page - both read as "no runs panel". A query still in flight is not
 * an answer either (D315): `undefined` until the cap answers with rows.
 */
import type { DeviceRun } from '@camstack/types'
import { useDeviceRunsListRuns } from '../../generated/system-hooks'

/** How many runs the panel and the bands are given; the cap's page size. */
export const DEVICE_RUNS_PAGE = 50
const REFRESH_MS = 60_000

/** The newest runs, or `undefined` while unanswered, absent or empty. */
export function useDeviceRuns(deviceId: number): readonly DeviceRun[] | undefined {
  const q = useDeviceRunsListRuns(
    { deviceId, limit: DEVICE_RUNS_PAGE },
    { staleTime: REFRESH_MS, refetchInterval: REFRESH_MS, retry: false },
  )
  if (q.status !== 'success' || q.data.runs.length === 0) return undefined
  return q.data.runs
}
