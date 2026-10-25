/**
 * Role display defaults — the operator's per-ROLE icon/unit/precision
 * (`deviceManager.getRoleDisplayDefaults`), published once at the top of a
 * surface and read by every row that draws a device.
 *
 * Why a context and not a hook per row: `deviceLeadIcon` is called in the row
 * header and in the accessory accordion, both of which render in tests and
 * in surfaces with no tRPC provider (a standalone `<DeviceItem>`). A generated
 * query hook throws outside its provider; a context degrades to "no defaults"
 * and the icon falls through to the built-in role glyph — which is exactly
 * what the resolution order says happens when there is no default.
 *
 * `RoleDisplayDefaultsFromServer` is the one component that calls the query
 * hook; mount it once inside `<trpc.Provider>` (the admin app does, in
 * `App.tsx`) and every list below it resolves the operator's role icon.
 */
import type { RoleDisplayDefault } from '@camstack/types'
import { createContext, useContext, type ReactNode } from 'react'
import { useDeviceManagerGetRoleDisplayDefaults } from '../../generated/system-hooks'

/** `role string → default`. Absent role = no default. */
export type RoleDisplayDefaults = Readonly<Record<string, RoleDisplayDefault>>

const EMPTY: RoleDisplayDefaults = {}

const RoleDisplayDefaultsContext = createContext<RoleDisplayDefaults>(EMPTY)

export interface RoleDisplayDefaultsProviderProps {
  readonly value: RoleDisplayDefaults
  readonly children: ReactNode
}

export function RoleDisplayDefaultsProvider({
  value,
  children,
}: RoleDisplayDefaultsProviderProps): ReactNode {
  return (
    <RoleDisplayDefaultsContext.Provider value={value}>
      {children}
    </RoleDisplayDefaultsContext.Provider>
  )
}

/** The defaults published by the nearest provider — an empty record outside
 *  one, never `undefined`, so a caller can index it without a guard. */
export function useRoleDisplayDefaults(): RoleDisplayDefaults {
  return useContext(RoleDisplayDefaultsContext)
}

export interface RoleDisplayDefaultsFromServerProps {
  readonly children: ReactNode
}

/**
 * Reads the defaults from the hub and publishes them. Until the query lands
 * the children see no defaults — the built-in role glyph, which is what they
 * would see with no operator default at all, so nothing flashes wrong.
 */
export function RoleDisplayDefaultsFromServer({
  children,
}: RoleDisplayDefaultsFromServerProps): ReactNode {
  const { data } = useDeviceManagerGetRoleDisplayDefaults({}, { staleTime: 60_000 })
  return (
    <RoleDisplayDefaultsProvider value={data?.defaults ?? EMPTY}>
      {children}
    </RoleDisplayDefaultsProvider>
  )
}
