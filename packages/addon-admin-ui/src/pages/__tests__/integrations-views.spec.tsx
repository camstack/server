// @vitest-environment jsdom
/**
 * Integrations page views: the last layout is remembered, and pending / empty /
 * error stay the same list whether the operator is on the table or the grid.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { INTEGRATIONS_VIEW_STORAGE_KEY } from '../../components/integrations/integrations-view-preference'

const integrations = [
  {
    id: 'int_reolink',
    addonId: 'provider-reolink',
    name: 'Reolink',
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
]

const queries = vi.hoisted(() => ({
  integrations: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  devices: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  addons: {
    data: undefined as unknown,
  },
}))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useIntegrationsList: () => queries.integrations,
    useIntegrationsGetAvailableTypes: () => ({ data: [], isLoading: false, isError: false }),
    useDeviceManagerListAll: () => queries.devices,
    useAddonsList: () => queries.addons,
    useSystem: () => ({ trpcClient: {} }),
  }
})

vi.mock('../../hooks/useEventInvalidation', () => ({
  useEventInvalidation: () => undefined,
}))

vi.mock('../../components/integrations/IntegrationWizard', () => ({
  IntegrationWizard: () => null,
}))

vi.mock('../../components/integrations/ScanNetworkModal', () => ({
  ScanNetworkModal: () => null,
}))

import { IntegrationsPage } from '../Integrations'

function Where(): ReactElement {
  const location = useLocation()
  return <span data-testid="where">{location.pathname}</span>
}

function renderPage(): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <IntegrationsPage />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

const addonRows = [
  { manifest: { id: 'provider-reolink', packageName: '@camstack/addon-provider-reolink' } },
  { manifest: { id: 'core-blocks', packageName: '@camstack/system' } },
]

beforeEach(() => {
  localStorage.clear()
  queries.addons.data = addonRows
  queries.integrations.data = integrations
  queries.integrations.isLoading = false
  queries.integrations.isError = false
  queries.devices.data = devices
  queries.devices.isLoading = false
  queries.devices.isError = false
})

describe('Integrations page views', () => {
  it('stays a table until the operator chooses the grid, and remembers that choice', () => {
    render(renderPage())
    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.queryByTestId('integration-card-provider-reolink')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Grid' }))
    expect(localStorage.getItem(INTEGRATIONS_VIEW_STORAGE_KEY)).toBe('grid')
    expect(screen.getByTestId('integration-card-provider-reolink')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('opens the remembered grid and reaches the integration from the card', () => {
    localStorage.setItem(INTEGRATIONS_VIEW_STORAGE_KEY, 'grid')
    render(renderPage())
    const card = screen.getByTestId('integration-card-provider-reolink')
    expect(card).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: 'Open Reolink' }))
    expect(screen.getByTestId('where').textContent).toBe('/integrations/provider-reolink')
  })

  it('shows the same error, pending and empty states in the grid as in the table', () => {
    localStorage.setItem(INTEGRATIONS_VIEW_STORAGE_KEY, 'grid')
    queries.integrations.isError = true
    queries.integrations.data = undefined
    const failed = render(renderPage())
    expect(screen.getByText('Integrations could not be loaded.')).toBeTruthy()
    expect(screen.queryByText('No integrations configured.')).toBeNull()
    expect(screen.queryByTestId('integration-card-provider-reolink')).toBeNull()
    failed.unmount()

    queries.integrations.isError = false
    queries.integrations.isLoading = true
    queries.integrations.data = undefined
    const pending = render(renderPage())
    expect(screen.getByTestId('integrations-pending')).toBeTruthy()
    expect(screen.queryByText('No integrations configured.')).toBeNull()
    pending.unmount()

    queries.integrations.isLoading = false
    queries.integrations.data = []
    queries.devices.data = []
    render(renderPage())
    expect(screen.getByText('No integrations configured.')).toBeTruthy()
    expect(screen.queryByTestId('integration-card-provider-reolink')).toBeNull()
  })

  describe('Providers and System blocks', () => {
    const withBlocks = [
      ...integrations,
      {
        id: 'int_blocks',
        addonId: 'core-blocks',
        name: 'Blocks',
        enabled: true,
        processState: 'running',
      },
    ]

    it('splits the table into a Providers and a System block', () => {
      queries.integrations.data = withBlocks
      render(renderPage())
      const providers = screen.getByTestId('integrations-section-providers')
      const system = screen.getByTestId('integrations-section-system')
      expect(within(providers).getByText('Reolink')).toBeTruthy()
      expect(within(providers).queryByText('Blocks')).toBeNull()
      expect(within(system).getByText('Blocks')).toBeTruthy()
    })

    it('splits the grid the same way', () => {
      localStorage.setItem(INTEGRATIONS_VIEW_STORAGE_KEY, 'grid')
      queries.integrations.data = withBlocks
      render(renderPage())
      expect(
        within(screen.getByTestId('integrations-section-providers')).getByTestId(
          'integration-card-provider-reolink',
        ),
      ).toBeTruthy()
      expect(
        within(screen.getByTestId('integrations-section-system')).getByTestId(
          'integration-card-core-blocks',
        ),
      ).toBeTruthy()
    })

    it('shows no System block when nothing system is configured, and no Providers block when only system is', () => {
      const first = render(renderPage())
      expect(screen.queryByTestId('integrations-section-system')).toBeNull()
      first.unmount()
      queries.integrations.data = [withBlocks[1]]
      render(renderPage())
      expect(screen.queryByTestId('integrations-section-providers')).toBeNull()
      expect(screen.getByTestId('integrations-section-system')).toBeTruthy()
    })
  })
})
