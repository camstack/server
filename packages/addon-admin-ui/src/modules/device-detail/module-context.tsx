import { createContext, type ReactNode, useContext } from 'react'
import type { DeviceModuleNavigation } from './types'

const NavigationContext = createContext<DeviceModuleNavigation>({})

export function DeviceModuleProvider({
  value,
  children,
}: {
  readonly value: DeviceModuleNavigation
  readonly children: ReactNode
}): ReactNode {
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>
}

/** The host's navigation callbacks; every one is optional. */
export function useDeviceModuleNavigation(): DeviceModuleNavigation {
  return useContext(NavigationContext)
}
