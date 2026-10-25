/**
 * Optional host-provided "open quick detail for this device id" callback.
 *
 * The devices table (`DeviceItem` / `DeviceList`) draws a discreet quick-
 * detail glyph whenever a host has published a handler — admin-ui mounts
 * ONE provider at the app shell with the modal. Call sites never wire the
 * button themselves; absence of a provider means no glyph (unit tests,
 * embeds that do not host the modal).
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
