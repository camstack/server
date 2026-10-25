/**
 * DeviceDetail — the header names the integration that CREATED the device,
 * not the addon that SERVES it.
 *
 * Live case: "Porch (composto)" is served by `composer` but belongs to
 * Blocks (`integrationId: int_0024`, addonId `core-blocks`). The old
 * `integrations.getByAddonId(device.addonId)` path labelled the breadcrumb
 * "composer" and linked nowhere.
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
}

const DEVICE = {
  id: 4603,
  name: 'Porch (composto)',
  stableId: 'composed-porch',
  addonId: 'composer',
  integrationId: 'int_0024',
  type: 'generic',
  online: true,
  disabled: false,
  parentDeviceId: null,
  features: [],
}

const integrationState = vi.hoisted(() => ({ answered: true }))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  const mutationStub = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })
  const emptyQuery = () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() })
  return {
    ...actual,
    useSystem: () => ({ trpcClient: {} }),
    useDeviceManagerGetDevice: ({ deviceId }: { deviceId: number }) => ({
      data: deviceId === DEVICE.id ? DEVICE : undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useDeviceManagerGetDeviceAggregate: emptyQuery,
    useIntegrationsList: () => ({
      data: integrationState.answered ? [BLOCKS] : undefined,
      isLoading: !integrationState.answered,
      isError: false,
      refetch: vi.fn(),
    }),
    useDeviceManagerRemove: mutationStub,
    useDeviceManagerDisable: mutationStub,
    useDeviceManagerEnable: mutationStub,
    useRebootReboot: mutationStub,
    useAddonsRestartAddon: mutationStub,
    useDeviceBattery: () => null,
    useDeviceNetworkLink: () => null,
    useIsMobile: () => false,
    usePipelineOrchestratorGetPipelineAssignment: emptyQuery,
    usePipelineRunnerGetCameraMetrics: emptyQuery,
    useAudioMetricsGetCurrentSnapshot: emptyQuery,
  }
})

vi.mock('../../hooks/useDevice', () => ({ useDeviceChildren: () => ({ data: [] }) }))
vi.mock('../../components/device/CameraFunctionSwitches', () => ({
  CameraFunctionSwitches: () => null,
}))
vi.mock('../../components/device/DeviceAdminLinkButton', () => ({
  DeviceAdminLinkButton: () => null,
}))
vi.mock('../../components/device/hero/HeroRegistry', () => ({ DeviceHero: () => null }))
vi.mock('../../components/device/PanelContent', () => ({
  EventsPanelContent: () => null,
  LogsPanelContent: () => null,
  ReplPanelContent: () => null,
  StatePanelContent: () => null,
  StreamPanelContent: () => null,
}))
vi.mock('../../components/device/tabs/OverviewTab', () => ({ OverviewTab: () => null }))
vi.mock('../../components/device/tabs/ConfigTab', () => ({ ConfigTab: () => null }))
vi.mock('../../components/device/tabs/BindingsTab', () => ({ BindingsTab: () => null }))
vi.mock('../../components/device/tabs/DetectionPipelineTab', () => ({
  DetectionPipelineTab: () => null,
}))
vi.mock('../../components/device/tabs/DeviceAggregateSection', () => ({
  DeviceAggregateSection: () => null,
}))

const auth = vi.hoisted(() => ({ isAdmin: true }))
vi.mock('../../contexts/auth-context', () => ({
  useAuth: () => ({ user: { isAdmin: auth.isAdmin } }),
}))
vi.mock('../../components/device/customize/CustomizeTab', () => ({
  CustomizeTab: () => <div>customize-body</div>,
}))

const { DeviceDetailPage } = await import('../DeviceDetail')

function renderPage(entry = '/devices/4603'): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <ConfirmDialogProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/devices/:deviceId" element={<DeviceDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmDialogProvider>
    </QueryClientProvider>
  )
}

describe('DeviceDetailPage — integration identity', () => {
  beforeEach(() => {
    integrationState.answered = true
    localStorage.clear()
  })

  it('shows and links Blocks for a device served by composer', () => {
    render(renderPage())
    expect(screen.getByText('Blocks')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open integration Blocks' })).toBeTruthy()
    expect(screen.queryByText('composer')).toBeNull()
  })

  it('while integrations.list is unanswered it renders unknown, not composer', () => {
    integrationState.answered = false
    render(renderPage())
    expect(screen.getByText('Loading integration…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /open integration/i })).toBeNull()
    expect(screen.queryByText('composer')).toBeNull()
  })
})

describe('DeviceDetailPage — the Customize tab (D676)', () => {
  beforeEach(() => {
    integrationState.answered = true
    auth.isAdmin = true
    localStorage.clear()
  })

  it('?tab=customize renders the Customize body for an admin', () => {
    render(renderPage('/devices/4603?tab=customize'))
    expect(screen.getByText('customize-body')).toBeTruthy()
  })

  it('a non-admin is not given the tab, even by URL', () => {
    auth.isAdmin = false
    render(renderPage('/devices/4603?tab=customize'))
    expect(screen.queryByText('customize-body')).toBeNull()
  })
})
