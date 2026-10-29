/**
 * The signed-in user's unit preferences, published by context so every
 * reading renders in the same units without a query of its own. Without a
 * provider (a spec, a standalone addon page) the default applies: metric, °C.
 */
import { createContext, type ReactElement, type ReactNode, useContext } from 'react'
import { DEFAULT_UNIT_PREFERENCES, type UnitPreferences } from '../lib/unit-preferences'

const UnitPreferencesContext = createContext<UnitPreferences>(DEFAULT_UNIT_PREFERENCES)

export function UnitPreferencesProvider({
  value,
  children,
}: {
  readonly value: UnitPreferences
  readonly children: ReactNode
}): ReactElement {
  return <UnitPreferencesContext.Provider value={value}>{children}</UnitPreferencesContext.Provider>
}

export function useUnitPreferences(): UnitPreferences {
  return useContext(UnitPreferencesContext)
}
