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
}))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useIntegrationsList: () => queries.integrations,
    useDeviceManagerListAll: () => queries.devices,
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

beforeEach(() => {
  localStorage.clear()
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
    expect(screen.queryByTestId('integration-card-int_reolink')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Grid' }))
    expect(localStorage.getItem(INTEGRATIONS_VIEW_STORAGE_KEY)).toBe('grid')
    expect(screen.getByTestId('integration-card-int_reolink')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('opens the remembered grid and reaches the integration from the card', () => {
    localStorage.setItem(INTEGRATIONS_VIEW_STORAGE_KEY, 'grid')
    render(renderPage())
    const card = screen.getByTestId('integration-card-int_reolink')
    expect(card).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: 'Open Reolink' }))
    expect(screen.getByTestId('where').textContent).toBe('/integrations/int_reolink')
  })

  it('shows the same error, pending and empty states in the grid as in the table', () => {
    localStorage.setItem(INTEGRATIONS_VIEW_STORAGE_KEY, 'grid')
    queries.integrations.isError = true
    queries.integrations.data = undefined
    const failed = render(renderPage())
    expect(screen.getByText('Integrations could not be loaded.')).toBeTruthy()
    expect(screen.queryByText('No integrations configured.')).toBeNull()
    expect(screen.queryByTestId('integration-card-int_reolink')).toBeNull()
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
    expect(screen.queryByTestId('integration-card-int_reolink')).toBeNull()
  })
})
