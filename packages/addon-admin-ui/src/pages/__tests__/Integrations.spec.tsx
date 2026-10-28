/**
 * Integrations page — renders the integrations list through the unified
 * `<DeviceList mode="generic">` (the bespoke `integrations-table.tsx` is
 * retired). Asserts integration rows render and expand to the nested
 * per-integration device list.
 *
 * The integration + device queries are stubbed on `@camstack/ui-library`; the
 * real `DeviceList` (generic + nested device mode) keeps its implementation so
 * the row → expansion → nested list wiring is exercised end to end.
 */
import { describe, it, expect, vi } from 'vitest'
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
  {
    id: 'int_onvif',
    addonId: 'provider-onvif',
    name: 'ONVIF',
    enabled: true,
    processState: 'running',
  },
  // D659: "Blocks" creates composed devices; `composer` serves them.
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
    enabled: true,
    capabilities: [],
  },
  {
    id: 2,
    name: 'Backyard',
    stableId: 'reo-2',
    addonId: 'provider-reolink',
    type: 'camera',
    online: true,
    enabled: true,
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
    enabled: true,
    capabilities: [],
  },
]

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useIntegrationsList: () => ({ data: integrations, isLoading: false, refetch: vi.fn() }),
    useDeviceManagerListAll: () => ({ data: devices, isLoading: false, refetch: vi.fn() }),
    useIntegrationsGetAvailableTypes: () => ({ data: [], isLoading: false, isError: false }),
    useAddonsList: () => ({ data: [] }),
    useSystem: () => ({ trpcClient: {} }),
  }
})

vi.mock('../../hooks/useEventInvalidation', () => ({
  useEventInvalidation: () => undefined,
}))

vi.mock('../../components/integrations/IntegrationWizard', () => ({
  IntegrationWizard: () => null,
}))

// Stubbed: it calls tRPC discovery hooks at render (even when closed) which
// need a tRPC context this page test does not provide.
vi.mock('../../components/integrations/ScanNetworkModal', () => ({
  ScanNetworkModal: () => null,
}))

import { IntegrationsPage } from '../Integrations'

function renderPage(initialEntry = '/'): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <IntegrationsPage />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('IntegrationsPage', () => {
  it('renders integration rows via the unified table with name, addonId and device count', () => {
    render(renderPage())
    expect(screen.getByText('Reolink')).toBeTruthy()
    expect(screen.getByText('ONVIF')).toBeTruthy()
    expect(screen.getAllByText('provider-reolink').length).toBeGreaterThan(0)
    // Reolink owns 2 of the devices; ONVIF owns 0.
    expect(screen.getByText('2 devices')).toBeTruthy()
    expect(screen.getByText('0 devices')).toBeTruthy()
  })

  it('expands the integration named by the ?expand= param to its nested device list', () => {
    // Single-open expansion is URL-driven (`?expand=<addonId>`). Render with the
    // Reolink integration already expanded and assert the nested
    // <DeviceList context="integration-detail"> shows that integration's devices.
    render(renderPage('/?expand=provider-reolink'))
    expect(screen.getByText('Front Door')).toBeTruthy()
    expect(screen.getByText('Backyard')).toBeTruthy()
    // A collapse affordance proves the row is in its expanded state.
    expect(screen.getAllByRole('button', { name: /collapse/i }).length).toBe(1)
  })

  it('counts and lists a composer-served device under Blocks, the integration that created it', () => {
    render(renderPage('/?expand=core-blocks'))
    // Blocks owns Porch: one device, not zero.
    expect(screen.getAllByText('1 device', { selector: 'td' }).length).toBe(1)
    expect(screen.getByText('Porch (composto)')).toBeTruthy()
    expect(screen.queryByText('Front Door')).toBeNull()
  })
})
