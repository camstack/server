/**
 * Fixture page for tables that no admin route mounts today (the node live tab, the device
 * track list and the debug tapes). Not an admin route: `ui:shots` mounts it for `/phone-tables-preview`; the data
 * comes from the `phone-tables` fixture area.
 */
import { AdminUiTextProvider } from '@admin/i18n/AdminUiTextProvider'
import i18n from '@admin/i18n'
import { TracksTab } from '@admin/components/device/tabs/TracksTab'
import { EventsDebugTapes } from '@admin/pages/EventsDebugTapes'
import { NodeLiveTab } from '@admin/components/pipeline/tabs/NodeLiveTab'
import { ConfirmDialogProvider, SystemProvider, ThemeProvider, trpc } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactElement, useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import { getSystem } from './stubs/backend'
import { fakeClient } from './stubs/transport'

export function PhoneTablesPreview(): ReactElement {
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
                <ConfirmDialogProvider>
                  <main className={`${theme} min-h-screen space-y-6 bg-background p-2 sm:p-4`}>
                    <NodeLiveTab nodeId="hub" refreshToken={0} />
                    <TracksTab deviceId={101} />
                    <EventsDebugTapes />
                  </main>
                </ConfirmDialogProvider>
              </ThemeProvider>
            </QueryClientProvider>
          </trpc.Provider>
        </SystemProvider>
      </AdminUiTextProvider>
    </I18nextProvider>
  )
}
