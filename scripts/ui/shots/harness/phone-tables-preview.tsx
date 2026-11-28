/**
 * Fixture page for tables that no admin route mounts today (the node live tab, the device
 * track list and the debug tapes). Not an admin route: `ui:shots` mounts it for `/phone-tables-preview`; the data
 * comes from the `phone-tables` fixture area.
 */

import { TracksTab } from '@admin/components/device/tabs/TracksTab'
import { NodeLiveTab } from '@admin/components/pipeline/tabs/NodeLiveTab'
import i18n from '@admin/i18n'
import { AdminUiTextProvider } from '@admin/i18n/AdminUiTextProvider'
import { EventsDebugTapes } from '@admin/pages/EventsDebugTapes'
import type { ConfigObjectArrayField } from '@dominevo/types'
import {
  ConfigFormField,
  ConfirmDialogProvider,
  DeviceList,
  SystemProvider,
  ThemeProvider,
  trpc,
} from '@dominevo/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactElement, useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import { ComparisonTable } from '../../../../packages/addon-training/src/page/ComparisonTable'
import {
  RetrainCanvasToolbar,
  useRetrainViewport,
} from '../../../../packages/addon-training/src/page/frames/RetrainCanvasToolbar'
import { COMPARISON_RESULT } from './phone-tables-training-result'
import { getSystem } from './stubs/backend'
import { fakeClient } from './stubs/transport'

function TrainingParts(): ReactElement {
  const view = useRetrainViewport()
  return (
    <div className="space-y-3">
      <ComparisonTable result={COMPARISON_RESULT} cameraName={(id) => `Camera ${String(id)}`} />
      <RetrainCanvasToolbar
        view={view}
        canUndo={false}
        canRedo={false}
        onUndo={() => undefined}
        onRedo={() => undefined}
      />
    </div>
  )
}

const SESSIONS_FIELD: ConfigObjectArrayField = {
  type: 'object-array',
  key: 'sessions',
  label: 'Sessions',
  columns: [
    { key: 'id', label: 'Id', kind: 'monospace' },
    { key: 'peer', label: 'Peer' },
    { key: 'state', label: 'State', kind: 'status' },
    { key: 'age', label: 'Age', kind: 'duration' },
    { key: 'seen', label: 'Last seen', kind: 'timestamp' },
  ],
  value: [
    { id: 'a1', peer: '192.0.2.4', state: 'ok', age: 4000, seen: 1_700_000_000_000 },
    { id: 'b2', peer: '192.0.2.9', state: 'warn', age: 96000, seen: 1_700_000_060_000 },
  ],
}

interface PagedRow {
  readonly id: number
  readonly name: string
}

const PAGED_ROWS: readonly PagedRow[] = Array.from({ length: 60 }, (_, i) => ({
  id: i + 1,
  name: `Example device number ${i + 1} with a long name`,
}))

/** A multi-page generic list, to shoot the footer (size selector + pager) on a phone. */
function PagedList(): ReactElement {
  return (
    <DeviceList<PagedRow>
      mode="generic"
      items={PAGED_ROWS}
      getKey={(r) => String(r.id)}
      getSearchText={(r) => r.name}
      columns={[
        {
          key: 'name',
          header: 'Name',
          cell: (r) => <span className="truncate text-xs">{r.name}</span>,
        },
        { key: 'id', header: 'Id', cell: (r) => r.id },
      ]}
      searchPlaceholder="Search"
      emptyLabel="none"
      pageSizeSelector={{ options: [10, 25], defaultSize: 10, storageKey: null }}
    />
  )
}

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
                    <TrainingParts />
                    <PagedList />
                    <ConfigFormField
                      field={SESSIONS_FIELD}
                      values={{}}
                      onChange={() => undefined}
                    />
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
