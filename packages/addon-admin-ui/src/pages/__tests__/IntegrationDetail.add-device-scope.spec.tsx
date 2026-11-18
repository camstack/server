/**
 * IntegrationDetail — what Add device may scan INSIDE an existing integration.
 *
 * The addon being a discovery provider only says it can find NEW integrations (consoles, hosts)
 * on the network; that belongs to the Integrations page. Inside an instance, Add device scans only
 * when the integration's discovery is scoped to that instance.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfirmDialogProvider } from '@camstack/ui-library'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

const scope = vi.hoisted(() => ({
  description: undefined as undefined | Record<string, unknown>,
  canScanSeen: [] as unknown[],
}))
const fleetReads = vi.hoisted(() => ({ calls: [] as unknown[][] }))
const switches = vi.hoisted(() => ({
  instance: vi.fn(),
  fixed: vi.fn(),
  remove: vi.fn(),
  removeInstance: vi.fn(),
}))
const integrationSettingsRead = vi.hoisted(() =>
  vi.fn(() => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() })),
)

const BASE_INTEGRATION = {
  id: 'int_unifi',
  addonId: 'provider-unifi',
  name: 'UniFi',
  enabled: true,
  processState: 'running',
  kind: 'device-adoption',
}
const DEVICES: unknown[] = []

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
      data: BASE_INTEGRATION,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    // Membership is resolved against `integrations.list` (the one rule).
    useIntegrationsList: () => ({
      data: [BASE_INTEGRATION],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useIntegrationsGetAvailableTypes: () => ({
      data: [
        { addonId: 'provider-unifi', name: 'UniFi', kind: 'device-adoption', brokerKind: null },
      ],
      isSuccess: true,
      isLoading: false,
      isError: false,
    }),
    useAddonSettingsGetIntegrationSettings: integrationSettingsRead,
    // The addon IS a discovery provider (it finds NEW consoles on the LAN).
    useDeviceManagerDiscoveryProviders: () => ({
      data: { providers: [{ addonId: 'provider-unifi', label: 'UniFi' }] },
      isPending: false,
    }),
    useIntegrationInstancesDescribe: () => ({ data: scope.description, isPending: false }),
    useIntegrationInstancesSetInstanceEnabled: () => ({
      mutate: switches.instance,
      isPending: false,
    }),
    useIntegrationsUpdate: () => ({ mutate: switches.fixed, isPending: false }),
    useIntegrationsDelete: () => ({ mutateAsync: switches.remove, isPending: false }),
    useIntegrationInstancesDeleteInstance: () => ({
      mutateAsync: switches.removeInstance,
      isPending: false,
    }),
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

vi.mock('../../components/integrations/AddDeviceModal', () => ({
  AddDeviceModal: (props: { canScan: boolean | null; onSetupIntegration?: unknown }) => {
    scope.canScanSeen.push(props.canScan)
    return (
      <div
        data-testid="add-device-modal"
        data-setup={String(props.onSetupIntegration !== undefined)}
      />
    )
  },
}))
vi.mock('../../components/integrations/AddDeviceDialog', () => ({ AddDeviceDialog: () => null }))
vi.mock('../../components/integrations/AdoptDevicesModal', () => ({
  AdoptDevicesModal: () => null,
}))
vi.mock('../../components/integrations/IntegrationInstanceEditor', () => ({
  IntegrationInstanceEditor: () => null,
}))
vi.mock('../../components/integrations/ScanNetworkModal', () => ({ ScanNetworkModal: () => null }))
vi.mock('../../components/settings/NodeAddonsSettingsPanel', () => ({
  NodeAddonsSettingsPanel: () => null,
}))

const { IntegrationDetailPage } = await import('../IntegrationDetail')

function openAddDevice(): unknown {
  scope.canScanSeen.length = 0
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ConfirmDialogProvider>
        <MemoryRouter initialEntries={['/integrations/provider-unifi?instance=int_unifi']}>
          <Routes>
            <Route path="/integrations/:addonId" element={<IntegrationDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmDialogProvider>
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: /add device/i }))
  return scope.canScanSeen[scope.canScanSeen.length - 1]
}

describe('IntegrationDetailPage - Add device scan scope', () => {
  it('does not offer a scan when the addon is a discovery provider but its discovery is not scoped to the instance', () => {
    scope.description = { kinds: [], discovery: { mode: 'lan', scopedToInstance: false } }
    expect(openAddDevice()).toBe(false)
    expect(screen.getByTestId('add-device-modal').getAttribute('data-setup')).toBe('false')
  })

  it('does not offer a scan when the type declares no discovery', () => {
    scope.description = { kinds: [] }
    expect(openAddDevice()).toBe(false)
  })

  it('offers the scan only when the discovery is scoped to the instance', () => {
    scope.description = { kinds: [], discovery: { mode: 'account', scopedToInstance: true } }
    expect(openAddDevice()).toBe(true)
  })
})
