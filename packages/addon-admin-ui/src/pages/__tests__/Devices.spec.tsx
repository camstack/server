/**
 * Devices page — smoke test that batch mode is wired on the universal device
 * table. The page passes `batchActions` (the real `deviceManager` remove /
 * disable / enable mutations) to `<DeviceList>`, so the shared composite
 * surfaces the "Select" activation button. The ui-library suite owns the full
 * batch-mode behaviour (activation → checkboxes → bulk bar → selected visual);
 * here we only assert the page-level wiring renders the activation affordance.
 *
 * Queries + mutation hooks are stubbed on `@camstack/ui-library`; the real
 * `DeviceList` keeps its implementation so the wiring is exercised end to end.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { ReactElement } from 'react'

const integrations = [
  {
    id: 'int_reolink',
    addonId: 'provider-reolink',
    name: 'Reolink',
    enabled: true,
    processState: 'running',
  },
  // D659: the "Blocks" integration CREATES composed devices; its own addonId
  // is `core-blocks`, while the addon that SERVES them is `composer`.
  {
    id: 'int_0024',
    addonId: 'core-blocks',
    name: 'Blocks',
    enabled: true,
    processState: 'running',
  },
]

const devices = [
  {
    id: 1,
    name: 'Front Door',
    stableId: 'reo-1',
    addonId: 'provider-reolink',
    type: 'camera',
    online: true,
    disabled: false,
    parentDeviceId: null,
    capabilities: [],
  },
  {
    id: 2,
    name: 'Backyard',
    stableId: 'reo-2',
    addonId: 'provider-reolink',
    type: 'camera',
    online: true,
    disabled: false,
    parentDeviceId: null,
    capabilities: [],
  },
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
    capabilities: [],
  },
]

const mutationStub = () => ({
  mutate: vi.fn(),
  mutateAsync: vi.fn(),
  isPending: false,
})

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useIntegrationsList: () => ({
      data: integrations,
      isLoading: false,
      refetch: vi.fn(),
    }),
    useIntegrationsGetAvailableTypes: () => ({
      data: [],
      isError: false,
      refetch: vi.fn(),
    }),
    useDeviceManagerListAll: () => ({
      data: devices,
      isLoading: false,
      refetch: vi.fn(),
    }),
    useDeviceManagerRemove: () => mutationStub(),
    useDeviceManagerDisable: () => mutationStub(),
    useDeviceManagerEnable: () => mutationStub(),
    useSystem: () => ({ trpcClient: {} }),
  }
})

vi.mock('../../hooks/useEventInvalidation', () => ({
  useEventInvalidation: () => undefined,
}))

import { DevicesPage } from '../Devices'

function renderPage(): ReactElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[window.location.pathname + window.location.search]}>
        <DevicesPage />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('DevicesPage', () => {
  beforeEach(() => {
    // The device list's filter state lives in the REAL location (url-state
    // reads `window.location`), so each test starts from a clean one.
    window.history.replaceState(null, '', '/devices')
    localStorage.clear()
  })

  it('renders the device rows', () => {
    render(renderPage())
    expect(screen.getByText('Front Door')).toBeTruthy()
    expect(screen.getByText('Backyard')).toBeTruthy()
  })

  it('wires batch mode — the "Select" activation button is present', () => {
    render(renderPage())
    expect(screen.getByRole('button', { name: /select/i })).toBeTruthy()
  })

  it('files a composer-served device under the integration that CREATED it (Blocks)', () => {
    window.history.replaceState(null, '', '/devices?addon=int_0024')
    render(renderPage())
    // The Blocks chip is on the page and selects Porch — not Reolink's rows.
    expect(screen.getAllByText('Blocks').length).toBeGreaterThan(0)
    expect(screen.getByText('Porch (composto)')).toBeTruthy()
    expect(screen.queryByText('Front Door')).toBeNull()
    // …and it is not in the orphan box.
    expect(screen.queryByText('Orphan devices')).toBeNull()
  })
})
