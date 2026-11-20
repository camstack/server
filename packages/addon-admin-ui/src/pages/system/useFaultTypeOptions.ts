import { useQueries, useQuery } from '@tanstack/react-query'
import { useSystem } from '@camstack/ui-library'

import { mergeFaultTypes } from './fault-type-options'
import type { PickOption } from './notification-rule-pickers'

const ERROR_CAP = 'error'

export interface FaultTypeOptions {
  readonly options: readonly PickOption[]
  readonly loading: boolean
}

/**
 * The fault codes a rule may name, as the integrations declare them
 * (`error.listFaultTypes`): the selected devices' catalogs, or, with no device
 * chosen, the union over every device that carries the `error` cap.
 */
export function useFaultTypeOptions(
  selectedDeviceIds: readonly number[] | undefined,
  enabled: boolean,
): FaultTypeOptions {
  const system = useSystem()
  const picked = selectedDeviceIds !== undefined && selectedDeviceIds.length > 0
  const carriers = useQuery({
    queryKey: [['deviceManager', 'listDeviceIdsByCaps'], { capNames: [ERROR_CAP] }],
    enabled: enabled && !picked,
    staleTime: 60_000,
    retry: false,
    queryFn: () =>
      system.trpcClient.deviceManager.listDeviceIdsByCaps.query({
        capNames: [ERROR_CAP],
      }),
  })
  const scope = picked ? selectedDeviceIds : (carriers.data ?? [])
  const catalogs = useQueries({
    queries: scope.map((deviceId) => ({
      queryKey: [['error', 'listFaultTypes'], { deviceId }],
      enabled,
      staleTime: 60_000,
      retry: false,
      queryFn: async () => (await system.trpcClient.error.listFaultTypes.query({ deviceId })).types,
    })),
  })
  return {
    options: mergeFaultTypes(catalogs.map((q) => q.data)),
    loading: carriers.isLoading || catalogs.some((q) => q.isLoading),
  }
}
