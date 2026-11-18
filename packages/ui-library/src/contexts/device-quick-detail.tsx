/**
 * Optional host-provided "open quick detail for this device id" callback.
 *
 * `DeviceItem` calls it when its row is clicked (outside selection mode):
 * admin-ui mounts ONE provider at the app shell with the modal. Call sites
 * never wire it themselves; without a provider (unit tests, embeds that do
 * not host the modal) a row click navigates to the device page.
 */
import { useContext, type ReactNode } from 'react'
import { createSharedContext } from '../lib/shared-context'

export type DeviceQuickDetailOpen = (deviceId: number) => void

const DeviceQuickDetailContext = createSharedContext<DeviceQuickDetailOpen | null>(
  'camstack:device-quick-detail',
  null,
)

export interface DeviceQuickDetailProviderProps {
  readonly open: DeviceQuickDetailOpen
  readonly children: ReactNode
}

export function DeviceQuickDetailProvider({
  open,
  children,
}: DeviceQuickDetailProviderProps): ReactNode {
  return (
    <DeviceQuickDetailContext.Provider value={open}>{children}</DeviceQuickDetailContext.Provider>
  )
}

/** The host's open callback, or null when no provider is mounted. */
export function useDeviceQuickDetailOpen(): DeviceQuickDetailOpen | null {
  return useContext(DeviceQuickDetailContext)
}
