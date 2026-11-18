/**
 * IntegrationDetail — what Add device may scan INSIDE an existing integration.
 *
 * The addon being a discovery provider only says it can find NEW integrations (consoles, hosts)
 * on the network; that belongs to the Integrations page. Inside an instance, Add device scans only
 * when the instance's provider says `addDevice: 'scan'` for it.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfirmDialogProvider } from '@camstack/ui-library'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

const scope = vi.hoisted(() => ({
  description: undefined as undefined | Record<string, unknown>,
  /** What the provider states for the selected instance (`IntegrationInstance.addDevice`). */
  addDevice: undefined as undefined | 'scan' | 'children' | 'none',
  getInstanceError: false,
  /** The addon holds `integration-instances` (false = a legacy discovery provider). */
  holder: true,
  describeError: false,
  seen: [] as { canScan: boolean | null; scanFailure: string | null }[],
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
    useAddonsListCapabilityProviders: () => ({
      data: scope.holder ? [{ addonId: 'provider-unifi' }] : [],
      isPending: false,
    }),
    useIntegrationInstancesDescribe: () =>
      scope.describeError
        ? { data: undefined, isPending: false, isError: true, error: new Error('describe refused') }
        : { data: scope.description, isPending: false, isError: false, error: null },
    useIntegrationInstancesGetInstance: () =>
      scope.getInstanceError
        ? { data: undefined, isPending: false, isError: true, error: new Error('instance refused') }
        : {
            data: { id: 'int_unifi', addDevice: scope.addDevice },
            isPending: false,
            isError: false,
            error: null,
          },
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
  AddDeviceModal: (props: { canScan: boolean | null; scanFailure?: string | null }) => {
    scope.seen.push({ canScan: props.canScan, scanFailure: props.scanFailure ?? null })
    return <div data-testid="add-device-modal" />
  },
}))

const { IntegrationDetailPage } = await import('../IntegrationDetail')

function openAddDevice(): { canScan: boolean | null; scanFailure: string | null } {
  scope.seen.length = 0
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
  const last = scope.seen[scope.seen.length - 1]
  if (last === undefined) throw new Error('the Add device modal was not drawn')
  return last
}

function setup(over: {
  holder?: boolean
  description?: Record<string, unknown>
  error?: boolean
  addDevice?: 'scan' | 'children' | 'none'
  instanceError?: boolean
}) {
  scope.holder = over.holder ?? true
  scope.description = over.description
  scope.describeError = over.error ?? false
  scope.addDevice = over.addDevice
  scope.getInstanceError = over.instanceError ?? false
}

describe('IntegrationDetailPage - Add device scan scope (decided per instance by its provider)', () => {
  it('scans when the instance says scan (a Reolink default integration)', () => {
    setup({ description: { kinds: [] }, addDevice: 'scan' })
    expect(openAddDevice()).toEqual({ canScan: true, scanFailure: null })
  })

  it('offers no scan when the instance says children (a Reolink NVR / Home Hub), whatever the discovery mode', () => {
    setup({
      description: { kinds: [], discovery: { mode: 'lan', scopedToInstance: false } },
      addDevice: 'children',
    })
    expect(openAddDevice()).toEqual({ canScan: false, scanFailure: null })
  })

  it('applies the server default when the instance serves no addDevice: lan keeps the scan', () => {
    setup({ description: { kinds: [], discovery: { mode: 'lan', scopedToInstance: false } } })
    expect(openAddDevice()).toEqual({ canScan: true, scanFailure: null })
  })

  it('applies the server default when the instance serves no addDevice: account offers no scan', () => {
    setup({ description: { kinds: [], discovery: { mode: 'account', scopedToInstance: true } } })
    expect(openAddDevice().canScan).toBe(false)
  })

  it('offers no scan when the instance says none', () => {
    setup({ description: { kinds: [] }, addDevice: 'none' })
    expect(openAddDevice().canScan).toBe(false)
  })

  it('offers no scan when the instance states nothing', () => {
    setup({ description: { kinds: [] } })
    expect(openAddDevice().canScan).toBe(false)
  })

  it('keeps the scan of a legacy discovery provider that has no instances description', () => {
    setup({ holder: false })
    expect(openAddDevice()).toEqual({ canScan: true, scanFailure: null })
  })

  it('shows no scan and names the reason when the description failed', () => {
    setup({ error: true })
    expect(openAddDevice()).toEqual({ canScan: false, scanFailure: 'describe refused' })
  })

  it('shows no scan and names the reason when the instance read failed', () => {
    setup({ description: { kinds: [] }, instanceError: true })
    expect(openAddDevice()).toEqual({ canScan: false, scanFailure: 'instance refused' })
  })
})
