/**
 * While a provider addon respawns (adoption / a settings change restarts its
 * runner) the hub answers the list calls with "provider not available". That is
 * not-yet-known, never broken: the page shows a reconnecting state and keeps
 * the rows it already had. A persistent, non-transient error stays an error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

interface ListState {
  data: unknown
  isLoading: boolean
  isError: boolean
  error: unknown
  errorUpdateCount: number
  refetch: () => void
}

const integrations = [
  {
    id: 'int_hm',
    addonId: 'provider-homematic',
    name: 'Homematic',
    enabled: true,
    processState: 'running',
  },
]

const integrationsState: ListState = {
  data: integrations,
  isLoading: false,
  isError: false,
  error: null,
  errorUpdateCount: 0,
  refetch: vi.fn(),
}
const devicesState: ListState = { ...integrationsState, data: [] }

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useIntegrationsList: () => integrationsState,
    useDeviceManagerListAll: () => devicesState,
    useIntegrationsGetAvailableTypes: () => ({ data: [], isLoading: false, isError: false }),
    useAddonsList: () => ({ data: [] }),
    useSystem: () => ({ trpcClient: {} }),
  }
})
vi.mock('../../hooks/useEventInvalidation', () => ({ useEventInvalidation: () => undefined }))
vi.mock('../../components/integrations/IntegrationWizard', () => ({
  IntegrationWizard: () => null,
}))
vi.mock('../../components/integrations/ScanNetworkModal', () => ({ ScanNetworkModal: () => null }))

import { IntegrationsPage } from '../Integrations'

function transient(): Error {
  return Object.assign(new Error('provider not available'), {
    data: { capRouteReason: 'no-provider' },
  })
}

function mount(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <IntegrationsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('IntegrationsPage transient errors', () => {
  beforeEach(() => {
    Object.assign(integrationsState, {
      data: integrations,
      isError: false,
      error: null,
      errorUpdateCount: 0,
    })
    Object.assign(devicesState, { data: [], isError: false, error: null, errorUpdateCount: 0 })
  })

  it('renders a reconnecting state, not the error box, when the list call is transient', () => {
    Object.assign(integrationsState, {
      data: undefined,
      isError: true,
      error: transient(),
      errorUpdateCount: 1,
    })
    mount()
    expect(screen.getByTestId('integrations-reconnecting')).toBeTruthy()
    expect(screen.queryByText(/could not be loaded/i)).toBeNull()
  })

  it('keeps the rows it already had while a refetch is transiently failing', () => {
    Object.assign(devicesState, { isError: true, error: transient(), errorUpdateCount: 2 })
    mount()
    expect(screen.getByText('Homematic')).toBeTruthy()
    expect(screen.queryByText(/could not be loaded/i)).toBeNull()
    expect(screen.getByTestId('integrations-reconnecting')).toBeTruthy()
  })

  it('still shows the error box for a persistent error', () => {
    Object.assign(integrationsState, {
      data: undefined,
      isError: true,
      error: new Error('Internal server error'),
      errorUpdateCount: 1,
    })
    mount()
    expect(screen.getByText(/could not be loaded/i)).toBeTruthy()
    expect(screen.queryByTestId('integrations-reconnecting')).toBeNull()
  })
})
