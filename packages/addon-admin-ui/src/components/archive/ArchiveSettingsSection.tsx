/**
 * Archive camera page → Settings: the device aggregate's recording sections
 * (`tab: 'recording'`), the same component the device page renders. Derived from the
 * capabilities, never a hand-written copy (D14).
 */
import { DeviceContextProvider } from '@dominevo/ui-library'
import type { ReactElement } from 'react'
import { DeviceAggregateSection } from '../device/tabs/DeviceAggregateSection'

export function ArchiveSettingsSection({ deviceId }: { readonly deviceId: number }): ReactElement {
  return (
    <DeviceContextProvider key={deviceId} deviceId={deviceId}>
      <DeviceAggregateSection
        deviceId={deviceId}
        sectionFilter={(s) => s.location === 'top-tab' && s.tab === 'recording'}
      />
    </DeviceContextProvider>
  )
}
