/** The four-state live value of one field (spec U12): the first read decides answered/failed, pushes keep it live. */
import { useDeviceCapSlice, useDeviceStateGetCapSlice, useSystem } from '@camstack/ui-library'
import { type LiveValue, type LiveValueTarget, liveValueOf } from './live-value'

const NO_DEVICE = 0

export function useLiveValue(target: LiveValueTarget | null): LiveValue {
  const system = useSystem()
  const query = useDeviceStateGetCapSlice(
    { deviceId: target?.deviceId ?? NO_DEVICE, capName: target?.cap ?? '' },
    { enabled: target !== null },
  )
  const pushed = useDeviceCapSlice(system.trpcClient, target?.deviceId ?? null, target?.cap ?? '')
  if (target === null) return { kind: 'absent' }
  return liveValueOf(
    {
      status: query.status,
      data: query.data,
      error:
        query.error === null || query.error === undefined ? null : { message: query.error.message },
    },
    pushed,
    target.path,
  )
}
