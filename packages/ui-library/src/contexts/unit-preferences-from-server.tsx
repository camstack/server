/**
 * Reads the user's unit preferences ONCE, at the top, and publishes them by
 * context. While the read is pending or failed, the default applies — a
 * reading is never withheld because the preference has not answered.
 */
import type { ReactElement, ReactNode } from 'react'
import { useAccountUnitPreferences } from '../hooks/use-account-unit-preferences'
import { UnitPreferencesProvider } from './unit-preferences'

export function UnitPreferencesFromServer({
  children,
}: {
  readonly children: ReactNode
}): ReactElement {
  const { value } = useAccountUnitPreferences()
  return <UnitPreferencesProvider value={value}>{children}</UnitPreferencesProvider>
}
