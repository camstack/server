import type { SystemTrpcClient } from '@camstack/ui-library'
import type { QueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'

export type DeviceModuleTheme = 'light' | 'dark'
export type DeviceModuleLocale = 'en' | 'it'

/** What the module asks its host to do when the operator leaves the card. */
export interface DeviceModuleNavigation {
  /** Open another device's page (a child, the plug that feeds this device). */
  readonly onOpenDevice?: (deviceId: number) => void
  /** Open a camera's live view. */
  readonly onOpenCamera?: (deviceId: number) => void
  /** The module has nothing more to show (a dialog it opened was dismissed from outside it). */
  readonly onClose?: () => void
  /** Follow a host-relative path the History view links to (the cross-device history page). */
  readonly onNavigate?: (path: string) => void
}

export interface DeviceDetailModuleProps extends DeviceModuleNavigation {
  readonly deviceId: number
  /** The hub's tRPC client: the only door the module reads and writes through. */
  readonly trpcClient: SystemTrpcClient
  readonly theme: DeviceModuleTheme
  readonly locale: DeviceModuleLocale
  /** Whether the viewer may run actions; false draws the card read-only. Default false. */
  readonly canActuate?: boolean
  /** A host cache to share; the module keeps its own when absent. */
  readonly queryClient?: QueryClient
  /** Open the History dialog on mount (a `?tab=history` deep link). */
  readonly defaultHistoryOpen?: boolean
  /** Drawn while the hero model does not cover the device yet. */
  readonly fallback?: ReactNode
  /** Told whether the hero model (not the fallback) is on screen. */
  readonly onDrawn?: (drawn: boolean) => void
}
