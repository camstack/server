import { useMemo } from 'react'
import { addonNameIndex, deviceNameIndex, type NameIndex } from '../composites/log-stream-names'
import { useAddonsList, useDeviceManagerListAll } from '../generated/system-hooks'

const NAMES_STALE_MS = 5 * 60_000

export interface LogNames {
  /** null until the list answered: a row then shows the id, not a guess. */
  readonly addons: NameIndex | null
  readonly devices: NameIndex | null
}

/**
 * Names for the integration and device columns: one addons list and one slim
 * device list for the whole table (cached by the query client, the same keys
 * the pickers use), each fetched only while its column is on screen.
 */
export function useLogNames(want: {
  readonly integration: boolean
  readonly device: boolean
}): LogNames {
  const addons = useAddonsList(undefined, { enabled: want.integration, staleTime: NAMES_STALE_MS })
  // No staleTime here: it is registered once on the query client for this shared key (D274).
  const devices = useDeviceManagerListAll({ projection: 'slim' }, { enabled: want.device })
  const addonIndex = useMemo(
    () => (addons.data === undefined ? null : addonNameIndex(addons.data)),
    [addons.data],
  )
  const deviceIndex = useMemo(
    () => (devices.data === undefined ? null : deviceNameIndex(devices.data)),
    [devices.data],
  )
  return { addons: addonIndex, devices: deviceIndex }
}
