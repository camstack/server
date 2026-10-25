/**
 * `useDeviceAutotrack` — typed wrapper around the `ptz-autotrack` cap.
 *
 * Surface:
 *   - `status` — current `{enabled, lastChangedAt, currentSettings}`,
 *      polled at 5s intervals while the hook is mounted.
 *   - `setEnabled(on)` — flip the on/off state.
 *   - `setSettings(partial)` — patch one or more settings keys.
 *   - `isPending` — true while a mutation is in flight.
 *
 * Returns `null` for `status` when the cap isn't available (device
 * doesn't support autotrack) — callers gate render on this OR on the
 * device's `PtzAutotrack` feature flag.
 */
import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { PtzAutotrackSettings, PtzAutotrackStatus } from '@camstack/types'

import {
  usePtzAutotrackGetStatus,
  usePtzAutotrackSetEnabled,
  usePtzAutotrackSetSettings,
} from '../generated/system-hooks'

export interface UseDeviceAutotrack {
  status: PtzAutotrackStatus | null
  isLoading: boolean
  isPending: boolean
  error: string | null
  setEnabled: (on: boolean) => Promise<void>
  setSettings: (patch: Partial<PtzAutotrackSettings>) => Promise<void>
}

export function useDeviceAutotrack(deviceId: number | null): UseDeviceAutotrack {
  const queryClient = useQueryClient()
  const enabled = deviceId !== null && Number.isFinite(deviceId)

  const statusQuery = usePtzAutotrackGetStatus(
    { deviceId: deviceId ?? 0 },
    {
      enabled,
      refetchInterval: 5_000,
      retry: 1,
    },
  )

  const setEnabledMutation = usePtzAutotrackSetEnabled({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [['ptzAutotrack']] })
    },
  })
  const setSettingsMutation = usePtzAutotrackSetSettings({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [['ptzAutotrack']] })
    },
  })

  const setEnabled = useCallback(
    async (on: boolean): Promise<void> => {
      if (deviceId === null) return
      await setEnabledMutation.mutateAsync({ deviceId, enabled: on })
    },
    [deviceId, setEnabledMutation],
  )

  const setSettings = useCallback(
    async (patch: Partial<PtzAutotrackSettings>): Promise<void> => {
      if (deviceId === null) return
      await setSettingsMutation.mutateAsync({ deviceId, settings: patch })
    },
    [deviceId, setSettingsMutation],
  )

  const errorMsg = (() => {
    if (statusQuery.error) return statusQuery.error.message
    if (setEnabledMutation.error) return setEnabledMutation.error.message
    if (setSettingsMutation.error) return setSettingsMutation.error.message
    return null
  })()

  return {
    // The codegen'd cap-router types getStatus output as
    // `unknown | null` (so the AppRouter type stays small); narrow
    // client-side via the cap's own status schema — documented
    // type boundary.
    status: (statusQuery.data ?? null) as PtzAutotrackStatus | null,
    isLoading: statusQuery.isLoading,
    isPending: setEnabledMutation.isPending || setSettingsMutation.isPending,
    error: errorMsg,
    setEnabled,
    setSettings,
  }
}
