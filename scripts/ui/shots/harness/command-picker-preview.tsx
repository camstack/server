/**
 * Fixture page for the automation Device command dialog. Not an admin route:
 * `ui:shots` mounts it for `/command-picker-preview`. The dialog opens on an
 * empty command so the device column is what the shot measures.
 *
 * `getSystem` is the harness stub (a relative import). The `@admin/lib/backend`
 * alias is the real client and would leave the device list pending.
 */
import { AdminUiTextProvider } from '@admin/i18n/AdminUiTextProvider'
import i18n from '@admin/i18n'
import type { AutomationDevice } from '@admin/pages/build/automation/automation-data'
import { CommandPickerDialog } from '@admin/pages/build/flow/CommandStep'
import { DeviceFleetProvider, SystemProvider, ThemeProvider, trpc } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactElement, useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import { getSystem } from './stubs/backend'
import { fakeClient } from './stubs/transport'

const DEVICES: readonly AutomationDevice[] = [
  { id: 1, name: 'Kitchen blind', stableId: 'example.1', type: 'cover' },
  { id: 2, name: 'Porch lamp', stableId: 'example.2', type: 'light' },
  { id: 3, name: 'Patio feeder', stableId: 'example.3', type: 'pet-feeder' },
]

/** Parent names on the rows come from this index, not a per-row read. */
const FLEET = [
  {
    id: 100,
    name: 'Living room hub',
    type: 'container',
    stableId: 'example.100',
    parentDeviceId: null,
  },
  {
    id: 1,
    name: 'Kitchen blind',
    type: 'cover',
    stableId: 'example.1',
    parentDeviceId: 100,
  },
  {
    id: 2,
    name: 'Porch lamp',
    type: 'light',
    stableId: 'example.2',
    parentDeviceId: 100,
  },
  {
    id: 3,
    name: 'Patio feeder',
    type: 'pet-feeder',
    stableId: 'example.3',
    parentDeviceId: null,
  },
]

const EMPTY = {
  kind: 'command' as const,
  target: { kind: 'devices' as const, ids: [] },
  actionId: '',
}

export function CommandPickerPreview(): ReactElement {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  )
  const theme = sessionStorage.getItem('ui-shots:theme') === 'dark' ? 'dark' : 'light'
  return (
    <I18nextProvider i18n={i18n}>
      <AdminUiTextProvider>
        <SystemProvider system={getSystem()}>
          <trpc.Provider client={fakeClient()} queryClient={client}>
            <QueryClientProvider client={client}>
              <ThemeProvider>
                <DeviceFleetProvider devices={FLEET}>
                  <main className={`${theme} min-h-screen bg-background`}>
                    <CommandPickerDialog
                      step={EMPTY}
                      devices={DEVICES}
                      variables={[]}
                      singleTarget={false}
                      onCancel={() => undefined}
                      onConfirm={() => undefined}
                    />
                  </main>
                </DeviceFleetProvider>
              </ThemeProvider>
            </QueryClientProvider>
          </trpc.Provider>
        </SystemProvider>
      </AdminUiTextProvider>
    </I18nextProvider>
  )
}
