/**
 * IntegrationDetail keyed by ADDON — several instances of one addon share a
 * page; `?instances=` picks which of them the table lists, the first when none
 * is named, and the table carries an Integration column.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfirmDialogProvider } from '@camstack/ui-library'
import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const WYZE_A = {
  id: 'int_a',
  addonId: 'provider-wyze',
  name: 'Casa',
  enabled: true,
  processState: 'running',
  kind: 'device-provider',
  info: {},
}
const WYZE_B = {
  id: 'int_b',
  addonId: 'provider-wyze',
  name: 'Garage',
  enabled: true,
  processState: 'running',
  kind: 'device-provider',
  info: {},
}
const SHC = {
  id: 'int_c',
  addonId: 'bosch-shc',
  name: 'Casa',
  enabled: true,
  processState: 'running',
  kind: 'device-provider',
  info: {},
}

const device = (id: number, name: string, integrationId: string) => ({
  id,
  name,
  stableId: `d-${String(id)}`,
  addonId: 'provider-wyze',
  integrationId,
  type: 'camera',
  online: true,
  disabled: false,
  parentDeviceId: null,
})
const DEVICES = [
  device(1, 'Cam One', 'int_a'),
  device(2, 'Cam Two', 'int_b'),
  device(3, 'Hub Three', 'int_c'),
]

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
    useIntegrationsGet: ({ id }: { id: string }) => ({
      data: [WYZE_A, WYZE_B, SHC].find((i) => i.id === id),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useIntegrationsList: () => ({
      data: [WYZE_A, WYZE_B, SHC],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useIntegrationsGetAvailableTypes: () => ({
      data: [
        {
          addonId: 'provider-wyze',
          name: 'Wyze',
          kind: 'device-provider',
          mode: 'standalone',
          brokerKind: null,
        },
      ],
      isSuccess: true,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
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

function renderAt(url: string): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <ConfirmDialogProvider>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="/integrations/:addonId" element={<IntegrationDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmDialogProvider>
    </QueryClientProvider>
  )
}

describe('IntegrationDetailPage — keyed by addon', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('selects the first instance when the URL names none, and shows its name in an Integration column', () => {
    render(renderAt('/integrations/provider-wyze'))
    expect(screen.getByRole('heading', { name: 'Wyze' })).toBeTruthy()
    expect(screen.getByText('Cam One')).toBeTruthy()
    expect(screen.queryByText('Cam Two')).toBeNull()
    expect(screen.queryByText('Hub Three')).toBeNull()
    expect(screen.getAllByText('Integration').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Casa').length).toBeGreaterThan(0)
  })

  it('lists the devices of every instance named in ?instances=', () => {
    render(renderAt('/integrations/provider-wyze?instances=int_a,int_b'))
    expect(screen.getByText('Cam One')).toBeTruthy()
    expect(screen.getByText('Cam Two')).toBeTruthy()
    expect(screen.queryByText('Hub Three')).toBeNull()
    expect(screen.getAllByText('Garage').length).toBeGreaterThan(0)
  })

  it('an old per-instance link lands on its addon with that instance selected', () => {
    render(renderAt('/integrations/int_b'))
    expect(screen.getByText('Cam Two')).toBeTruthy()
    expect(screen.queryByText('Cam One')).toBeNull()
  })
})
