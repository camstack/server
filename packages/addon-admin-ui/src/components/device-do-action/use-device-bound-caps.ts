/**
 * Bound capability names for one device — shared by the Device→Do picker
 * (NC Sequences / Automations) so both surfaces ask the same question.
 */

import { useSystem } from '@camstack/ui-library'
import { type UseQueryResult, useQuery } from '@tanstack/react-query'

const STALE_MS = 60_000

/** Empty until a device is chosen — `deviceId` 0 is "not picked yet". */
export function useDeviceBoundCaps(deviceId: number): UseQueryResult<readonly string[]> {
  const system = useSystem()
  return useQuery({
    queryKey: ['device-do-action', 'bound-caps', deviceId],
    enabled: deviceId > 0,
    staleTime: STALE_MS,
    queryFn: async (): Promise<readonly string[]> => {
      const res = await system.trpcClient.deviceManager.getBindings.query({ deviceId })
      return [...new Set(res.entries.map((e) => e.capName))].sort((a, b) => a.localeCompare(b))
    },
  })
}

/**
 * Bound caps for several devices in ONE round-trip — multi-target Do steps
 * (same family) need the intersection of catalogue actions.
 *
 * Keyed by a stable sorted id list so reordering the selection does not
 * refetch. Empty / all-zero ids stay disabled.
 */
export function useDevicesBoundCaps(
  deviceIds: readonly number[],
): UseQueryResult<ReadonlyMap<number, readonly string[]>> {
  const system = useSystem()
  const ids = [...new Set(deviceIds.filter((id) => id > 0))].sort((a, b) => a - b)
  return useQuery({
    queryKey: ['device-do-action', 'bound-caps-batch', ids],
    enabled: ids.length > 0,
    staleTime: STALE_MS,
    queryFn: async (): Promise<ReadonlyMap<number, readonly string[]>> => {
      const rows = await system.trpcClient.deviceManager.getBindingsBatch.query({
        deviceIds: ids,
      })
      const out = new Map<number, readonly string[]>()
      for (const row of rows) {
        out.set(
          row.deviceId,
          [...new Set(row.entries.map((e) => e.capName))].sort((a, b) => a.localeCompare(b)),
        )
      }
      return out
    },
  })
}
