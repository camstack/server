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
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

const fleetReads = vi.hoisted(() => ({ calls: [] as unknown[][] }))
const switches = vi.hoisted(() => ({ instance: vi.fn(), fixed: vi.fn() }))

const BASE_INTEGRATION = {
  id: 'int_reolink',
  addonId: 'provider-reolink',
  name: 'Reolink',
  enabled: true,
  processState: 'running',
  kind: 'device-provider',
}
const shown = vi.hoisted(() => ({ integration: null as null | Record<string, unknown> }))

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

/** Stands where the retired integration-level read was: nothing may call it. */
const integrationSettingsRead = vi.hoisted(() =>
  vi.fn(() => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() })),
)

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
      data: shown.integration ?? BASE_INTEGRATION,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    // Membership is resolved against `integrations.list` (the one rule).
    useIntegrationsList: () => ({
      data: [shown.integration ?? BASE_INTEGRATION],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useIntegrationsGetAvailableTypes: emptyQuery,
    useAddonSettingsGetIntegrationFormSchema: emptyQuery,
    useAddonSettingsGetIntegrationSettings: integrationSettingsRead,
    useDeviceManagerDiscoveryProviders: emptyQuery,
    useIntegrationInstancesSetInstanceEnabled: () => ({
      mutate: switches.instance,
      isPending: false,
    }),
    useIntegrationsUpdate: () => ({ mutate: switches.fixed, isPending: false }),
    useIntegrationInstancesDeleteInstance: mutationStub,
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
vi.mock('../../components/integrations/IntegrationInstanceEditor', () => ({
  IntegrationInstanceEditor: () => null,
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
        <MemoryRouter initialEntries={['/integrations/provider-reolink?instance=int_reolink']}>
          <Routes>
            <Route path="/integrations/:addonId" element={<IntegrationDetailPage />} />
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

describe('IntegrationDetailPage - no addon-level settings read', () => {
  it('never reads the integration-level settings of its addon (D986)', () => {
    integrationSettingsRead.mockClear()
    render(renderPage())
    expect(integrationSettingsRead).not.toHaveBeenCalled()
  })
})

describe('IntegrationDetailPage - the one switch', () => {
  it('toggles an integration through setInstanceEnabled with its addon', () => {
    shown.integration = null
    switches.instance.mockReset()
    render(renderPage())

    fireEvent.click(screen.getByRole('switch', { name: 'Disable integration' }))

    expect(switches.instance).toHaveBeenCalledWith({
      id: 'int_reolink',
      addonId: 'provider-reolink',
      enabled: false,
    })
  })

  it('switches a FIXED builtin through the registry flag (no addon provider needed), not setInstanceEnabled', () => {
    shown.integration = { ...BASE_INTEGRATION, info: { fixed: true } }
    switches.instance.mockReset()
    switches.fixed.mockReset()
    render(renderPage())

    fireEvent.click(screen.getByRole('switch', { name: 'Disable integration' }))

    expect(switches.fixed).toHaveBeenCalledWith({ id: 'int_reolink', enabled: false })
    expect(switches.instance).not.toHaveBeenCalled()
    shown.integration = null
  })

  it('does not draw a switch the addon could not answer for as on or off (D315)', () => {
    shown.integration = { ...BASE_INTEGRATION, switchUnknown: true }
    switches.instance.mockReset()
    render(renderPage())

    const unknown = screen.getByRole('switch', { name: 'Unknown' })
    expect(unknown).toBeDisabled()
    expect(screen.queryByText('Enabled')).toBeNull()
    expect(screen.queryByText('Disabled')).toBeNull()
    // The label is not drawn green either (the stored flag is stale, not the state).
    expect(
      screen.getAllByText('Unknown').every((el) => !el.className.includes('text-success')),
    ).toBe(true)
    shown.integration = null
  })
})
