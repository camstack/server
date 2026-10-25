/**
 * IntegrationDetail — the SHAPE of its fleet read.
 *
 * The 2026-08-31 timer-driven-collection audit listed this page as defect #5,
 * "`deviceManager.listAll`, 30 s, deliberately non-slim per its own comment".
 * The comment says the opposite and has since 791cf8f9a (2026-08-27): the page
 * asks `{ projection: 'slim' }` precisely SO THAT it shares one cache entry
 * with Devices, GlobalSearch, ScanNetworkModal and ScopePreview instead of
 * paying its own full fetch. This file exists so that fact stops being
 * re-litigated from a stale note, and so the next "optimisation" cannot widen
 * it back without going red.
 *
 * The three things pinned, all on the CALL — the rendered rows are identical
 * under every one of them, which is exactly why asserting on rows would prove
 * nothing:
 *
 *  - **`{ projection: 'slim' }`, and nothing else.** Narrowing it further to
 *    `{ addonId }` is the tempting move and is wrong twice: it mints a PRIVATE
 *    query key (so a warm client pays an extra whole-fleet-shaped read instead
 *    of zero), and it drops the rows this page needs from OUTSIDE the
 *    integration — `parentById` resolves an accessory's parent name over the
 *    whole fleet, and `<DeviceList>` computes a container's effective type from
 *    children it looks up the same way. `forceIntegrationId` already does the
 *    filtering, on the client, after those lookups.
 *  - **No `staleTime` / `gcTime` at the call site.** D274 owns the window on
 *    the query client; a local re-declaration is the 21-owners problem coming
 *    back, and `scripts/check-fleet-query-defaults.ts` fails it.
 *  - **A `refetchInterval` is present.** This surface wants the online column
 *    live; the window alone would not refresh a page left open.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfirmDialogProvider } from '@camstack/ui-library'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

const fleetReads = vi.hoisted(() => ({ calls: [] as unknown[][] }))

const INTEGRATION = {
  id: 'int_reolink',
  addonId: 'provider-reolink',
  name: 'Reolink',
  enabled: true,
  processState: 'running',
  kind: 'device-provider',
}

const DEVICES = [
  {
    id: 1,
    name: 'Front Door',
    stableId: 'reo-1',
    addonId: 'provider-reolink',
    type: 'camera',
    online: true,
    disabled: false,
    parentDeviceId: null,
  },
]

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  // Defined HERE, not at module top level. `vi.mock` is hoisted above every
  // top-level binding, so a factory that closes over one crashes with
  // "Cannot access X before initialization" the moment anything makes the
  // mocked module load earlier — which importing one of its exports does.
  const mutationStub = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })
  const emptyQuery = () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() })
  return {
    ...actual,
    useSystem: () => ({ trpcClient: {} }),
    useDeviceManagerListAll: (...args: unknown[]) => {
      fleetReads.calls.push(args)
      return { data: DEVICES, isLoading: false, isError: false, refetch: vi.fn() }
    },
    useIntegrationsGet: () => ({
      data: INTEGRATION,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    // Membership is resolved against `integrations.list` (the one rule).
    useIntegrationsList: () => ({
      data: [INTEGRATION],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useIntegrationsGetAvailableTypes: emptyQuery,
    useAddonSettingsGetGlobalSettings: emptyQuery,
    useAddonSettingsGetIntegrationSettings: emptyQuery,
    useDeviceManagerDiscoveryProviders: emptyQuery,
    useIntegrationsUpdate: mutationStub,
    useIntegrationsDelete: mutationStub,
    useAddonsRestartAddon: mutationStub,
    useDeviceManagerRemove: mutationStub,
    useDeviceManagerDisable: mutationStub,
    useDeviceManagerEnable: mutationStub,
  }
})

vi.mock('../../components/integrations/AddDeviceDialog', () => ({
  AddDeviceDialog: () => null,
}))
vi.mock('../../components/integrations/AdoptDevicesModal', () => ({
  AdoptDevicesModal: () => null,
}))
vi.mock('../../components/integrations/IntegrationConfigModal', () => ({
  IntegrationConfigModal: () => null,
}))
vi.mock('../../components/integrations/ScanNetworkModal', () => ({
  ScanNetworkModal: () => null,
}))
vi.mock('../../components/settings/NodeAddonsSettingsPanel', () => ({
  NodeAddonsSettingsPanel: () => null,
}))

const { IntegrationDetailPage } = await import('../IntegrationDetail')

function renderPage(): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      {/* The page renders a TABLE now — the cards view it used to default to
          is gone — and the table's row actions include Delete, which asks
          through this context. In the app it comes from App.tsx. Mocking the
          `useConfirm` export does NOT work: the caller lives inside the
          ui-library bundle and resolves it internally. */}
      <ConfirmDialogProvider>
        <MemoryRouter initialEntries={['/integrations/int_reolink']}>
          <Routes>
            <Route path="/integrations/:integrationId" element={<IntegrationDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmDialogProvider>
    </QueryClientProvider>
  )
}

describe('IntegrationDetailPage — fleet read shape', () => {
  it('asks the SHARED slim key — not the full projection, not an addon-scoped one', () => {
    fleetReads.calls.length = 0
    render(renderPage())

    expect(fleetReads.calls.length).toBeGreaterThan(0)
    expect(fleetReads.calls[0]?.[0]).toEqual({ projection: 'slim' })
  })

  it('keeps the online column live, and declares no window of its own', () => {
    fleetReads.calls.length = 0
    render(renderPage())

    const options = fleetReads.calls[0]?.[1]
    expect(options).toMatchObject({ refetchInterval: 30_000 })
    expect(options).not.toHaveProperty('staleTime')
    expect(options).not.toHaveProperty('gcTime')
  })
})
