/**
 * IntegrationDetail — WHICH devices the page lists.
 *
 * Live (2026-09-28): "Porch (composto)", id 4603, is a composed device
 * (D659). Its row reads `addonId: 'composer'` (the addon that SERVES it) and
 * `integrationId: 'int_0024'` (the "Blocks" integration that CREATED it,
 * whose own addonId is `core-blocks`). The page filtered the fleet by
 * `d.addonId === integration.addonId`, so the Blocks page did not list it and
 * the operator saw it "under no integration". Membership is the one rule
 * (`deviceIntegrationResolver`): `integrationId` first, `addonId` only for
 * legacy rows.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfirmDialogProvider } from '@camstack/ui-library'
import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const BLOCKS = {
  id: 'int_0024',
  addonId: 'core-blocks',
  name: 'Blocks',
  enabled: true,
  processState: 'running',
  kind: 'device-provider',
}
const REOLINK = {
  id: 'int_reolink',
  addonId: 'provider-reolink',
  name: 'Reolink',
  enabled: true,
  processState: 'running',
  kind: 'device-provider',
}

const DEVICES = [
  {
    id: 4603,
    name: 'Porch (composto)',
    stableId: 'composed-porch',
    addonId: 'composer',
    integrationId: 'int_0024',
    type: 'camera',
    online: true,
    disabled: false,
    parentDeviceId: null,
  },
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

const listState = vi.hoisted(() => ({ answered: true }))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  const mutationStub = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })
  const emptyQuery = () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() })
  return {
    ...actual,
    useSystem: () => ({ trpcClient: {} }),
    useDeviceManagerListAll: () => ({
      data: DEVICES,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useIntegrationsGet: () => ({
      data: BLOCKS,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useIntegrationsList: () => ({
      data: listState.answered ? [REOLINK, BLOCKS] : undefined,
      isLoading: !listState.answered,
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

vi.mock('../../components/integrations/AddDeviceDialog', () => ({ AddDeviceDialog: () => null }))
vi.mock('../../components/integrations/AdoptDevicesModal', () => ({
  AdoptDevicesModal: () => null,
}))
vi.mock('../../components/integrations/IntegrationConfigModal', () => ({
  IntegrationConfigModal: () => null,
}))
vi.mock('../../components/integrations/ScanNetworkModal', () => ({ ScanNetworkModal: () => null }))
vi.mock('../../components/settings/NodeAddonsSettingsPanel', () => ({
  NodeAddonsSettingsPanel: () => null,
}))

const { IntegrationDetailPage } = await import('../IntegrationDetail')

function renderPage(): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <ConfirmDialogProvider>
        <MemoryRouter initialEntries={['/integrations/core-blocks?instance=int_0024']}>
          <Routes>
            <Route path="/integrations/:addonId" element={<IntegrationDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmDialogProvider>
    </QueryClientProvider>
  )
}

describe('IntegrationDetailPage — a composed device is listed under Blocks', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/integrations/int_0024')
    localStorage.clear()
    listState.answered = true
  })

  it('the addon page lists the composer-served device created by Blocks, and nothing of Reolink', () => {
    render(renderPage())
    expect(screen.getByText('Porch (composto)')).toBeTruthy()
    expect(screen.queryByText('Front Door')).toBeNull()
    expect(screen.getAllByText(/^1\s+devices?$/i).length).toBeGreaterThan(0)
  })

  it('while integrations.list is unanswered it claims neither a count nor an empty list', () => {
    listState.answered = false
    render(renderPage())
    // The page waits for the list: no title, no count, no empty-list claim.
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.queryByText(/no devices match/i)).toBeNull()
  })
})
